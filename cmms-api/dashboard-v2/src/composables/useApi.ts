// src/composables/useApi.ts
//
// Thin, typed `fetch` wrapper for the CMMS Dashboard v2.
//
// All requests go to `/dashboard/api/*` (relative; the Vite dev proxy
// and the prod server both serve these on the same origin).
// `credentials: 'same-origin'` so the dashboard session cookie is sent.
//
// On non-2xx responses we throw an `ApiErrorBody`
// (`{ status, message, body }`) so the retry composable in
// `useApiWithRetry.ts` can detect `cmms-api unavailable` and
// `network down` by inspecting `body.error` and `status`.
//
// On network error (fetch itself rejects — `TypeError: Failed to fetch`,
// `code: 'NETWORK_ERROR'`) we throw with `status: 0`, `message:
// 'Network error'`, `body: undefined` so the retry composable can
// treat it as the "network-down" trigger.
//
// `api.stream()` returns a real `EventSource` (not a promise) because
// EventSource has its own state machine and lifecycle.
//
// NO Vue reactivity, NO Pinia — this is a stateless HTTP wrapper. P4.3
// (`useApiWithRetry.ts`) and Phase 5 (vue-query) wrap the returned
// promises with their own caching/retry behavior.

import type {
  AnswerAgentJobStart,
  AnswerAgentJobState,
  AnswerAgentRequest,
  AnswerAgentResponse,
  AnswerRequest,
  AnswerResponse,
  ApprovalResponse,
  AuditResponse,
  DevicesResponse,
  DiffResponse,
  FeedbackCorrectionRequest,
  FeedbackCorrectionResponse,
  FeedbackCounters,
  FeedbackMyCorrectionsResponse,
  FeedbackMyVotesResponse,
  FeedbackVoteRequest,
  FeedbackVoteResponse,
  MapResponse,
  TicketDetails,
  TokenRotateResponse,
  TokensResponse,
} from '@/lib/api'
import { getSessionToken } from './useSessionToken'
import { getOrCreateCmmsUid } from '@/lib/feedback'

// ---------------------------------------------------------------------------
// Re-export the thrown error shape from lib/api so callers can import it
// from this module if they prefer. P4.3 already declares its own
// structurally-identical `ApiErrorBody`; this is the canonical one.
// ---------------------------------------------------------------------------

export type { ApiErrorBody } from '@/lib/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for errors thrown by `jsonRequest()`. Callers use this to
 * distinguish a structured `ApiErrorBody` from a random `TypeError` that
 * slipped through (e.g. a programming bug in a queryFn).
 */
export function isApiErrorBody(err: unknown): err is import('@/lib/api').ApiErrorBody {
  if (typeof err !== 'object' || err === null) return false
  const e = err as Record<string, unknown>
  return (
    typeof e.status === 'number' &&
    typeof e.message === 'string' &&
    'body' in e
  )
}

/**
 * Underlying fetch helper. Performs the request, parses the JSON
 * response on 2xx, and throws an `ApiErrorBody` on non-2xx or on
 * transport failure.
 *
 * Callers should not need to use this directly — the `api` object
 * below wraps every endpoint.
 */
async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // Bridge the v1 sessionStorage token onto every request. The server
  // checks `Authorization: Bearer <token>` as a fallback when the
  // session cookie is missing (e.g. cleared cookies / new tab after
  // a successful login in the same tab). Without this, v2 fetches would
  // 401 the moment the cookie expires, even though the user is still
  // logged in this tab.
  const token = getSessionToken()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token.length > 0 && headers['Authorization'] === undefined && headers['authorization'] === undefined) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers,
    })
  } catch (e) {
    // Transport-level failure (network down, CORS, abort, etc.).
    // fetch rejects with TypeError on Chromium / NetworkError on Firefox.
    // Normalize to status: 0 so the retry composable can branch on it.
    const detail =
      e instanceof TypeError ? e.message : 'Network error'
    throw {
      status: 0,
      message: 'Network error',
      body: undefined,
      cause: detail,
    }
  }

  // 2xx — parse and return. We accept any 2xx (200, 201, 204, …).
  if (response.status >= 200 && response.status < 300) {
    // 204 No Content / empty body — let callers opt into a void shape
    // by declaring T as `void`; we just return undefined as T here.
    if (response.status === 204) {
      return undefined as T
    }
    try {
      return (await response.json()) as T
    } catch (e) {
      // Server claimed 2xx but the body wasn't JSON. Surface as 502-ish.
      throw {
        status: response.status,
        message: `HTTP ${response.status} (invalid JSON body)`,
        body: undefined,
        cause: e instanceof Error ? e.message : String(e),
      }
    }
  }

  // Non-2xx — try to extract a structured { error, detail, hint } body
  // for the retry composable. Don't fail the parse path if the body
  // is empty or non-JSON.
  let body: unknown = undefined
  try {
    const text = await response.text()
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
  } catch {
    // ignore — body stays undefined
  }

  throw {
    status: response.status,
    message: `HTTP ${response.status}`,
    body,
  }
}

// ---------------------------------------------------------------------------
// The api object — one method per endpoint.
//
// Endpoint map (proxied through /dashboard/api/*):
//
//   POST /dashboard/api/answer            api.answer()
//   GET  /dashboard/api/map?period=…      api.map()
//   GET  /dashboard/api/audit?limit=…     api.audit()
//   GET  /dashboard/api/diff?since=…      api.diff()
//   GET  /dashboard/api/ticket?sorszam=…  api.getTicketBySorszam()
//   GET  /dashboard/api/tokens            api.tokens()
//   POST /dashboard/api/tokens/rotate     api.rotateToken()
//   POST /dashboard/api/approvals/:id     api.resolveApproval()
//   GET  /dashboard/api/stream            api.stream()  (EventSource)
//
// All request bodies are JSON; Content-Type is set on POSTs that carry
// a body. GETs leave Content-Type alone (browsers strip it without a
// body anyway).
// ---------------------------------------------------------------------------

const api = {
  /**
   * POST /dashboard/api/answer
   *   body: AnswerRequest
   *   resp: AnswerResponse
   */
  answer(req: AnswerRequest): Promise<AnswerResponse> {
    return jsonRequest<AnswerResponse>('/dashboard/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  /**
   * POST /dashboard/api/answer-agent  (legacy synchronous contract)
   *   body: AnswerAgentRequest
   *   resp: AnswerAgentResponse
   * Keep for compatibility; AskPage now prefers the async job flow.
   */
  answerAgent(req: AnswerAgentRequest): Promise<AnswerAgentResponse> {
    return jsonRequest<AnswerAgentResponse>('/dashboard/api/answer-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  /**
   * POST /dashboard/api/answer-agent  (async job start)
   *   body: { ...AnswerAgentRequest, async: true }
   *   resp: AnswerAgentJobState  — 202 { job_id, status: "running" }
   *
   * The zrok edge cuts proxied responses at ~60s, so complex questions
   * run as a background job on cmms-api. The SPA then polls
   * answerAgentPoll(jobId) until status becomes "done" / "error".
   */
  answerAgentAsync(req: AnswerAgentRequest): Promise<AnswerAgentJobStart> {
    return jsonRequest<AnswerAgentJobStart>('/dashboard/api/answer-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, async: true }),
    })
  },

  /**
   * POST /dashboard/api/answer-agent/:jobId
   *   resp: AnswerAgentJobState — running | done (with result) | error
   */
  answerAgentPoll(jobId: string): Promise<AnswerAgentJobState> {
    return jsonRequest<AnswerAgentJobState>(
      `/dashboard/api/answer-agent/${encodeURIComponent(jobId)}`,
      { headers: { 'Content-Type': 'application/json' } },
    )
  },

  /**
   * POST /dashboard/api/answer-agent/stream  (SSE)
   *   body: AnswerAgentRequest
   *   resp: RAW Response — the body is a `text/event-stream` frame
   *   sequence, NOT JSON. The caller consumes it with
   *   consumeAgentStream() (useAgentStream.ts).
   *
   *   Unlike every other api.* method this returns the raw fetch
   *   Response (unparsed) because the body is not JSON. The caller
   *   checks res.ok and the content-type, then reads res.body.
   *   Transport failures throw the usual ApiErrorBody (status 0).
   */
  answerAgentStream(req: AnswerAgentRequest): Promise<Response> {
    const token = getSessionToken()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (token.length > 0) headers['Authorization'] = `Bearer ${token}`
    return fetch('/dashboard/api/answer-agent/stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(req),
    }).catch((e) => {
      const detail = e instanceof TypeError ? e.message : 'Network error'
      throw { status: 0, message: 'Network error', body: undefined, cause: detail }
    })
  },

  /**
   * GET /dashboard/api/devices?q=…&limit=…
   *   resp: DevicesResponse — { devices: [{ name, tickets }], q, limit }
   *   Substring device search for the machine-scope picker.
   */
  devices(q: string, limit = 20): Promise<DevicesResponse> {
    const qs = new URLSearchParams({ q, limit: String(limit) }).toString()
    return jsonRequest<DevicesResponse>(`/dashboard/api/devices?${qs}`)
  },

  /**
   * GET /dashboard/api/map?period=…
   *   resp: MapResponse
   */
  map(period: string): Promise<MapResponse> {
    const qs = new URLSearchParams({ period }).toString()
    return jsonRequest<MapResponse>(`/dashboard/api/map?${qs}`)
  },

  /**
   * POST /v1/jobs/search (proxied through /dashboard/api/jobs/search).
   *
   * On-demand ticket search used by the Map page's node inspector for
   * low-volume machine types whose server-baked `samples` list came
   * back empty. The `device` filter is a substring match against the
   * parsed device model, so it picks up related models in the same
   * family (e.g. searching for "Forg.kihord" also returns tickets
   * for any device whose model contains "forg.kihord" as a substring).
   *
   * Body: { device?, period?, limit? }
   *   resp: JobsSearchResponse (defined in lib/api.ts)
   */
  searchJobs(req: { device?: string; period?: string; limit?: number }): Promise<unknown> {
    return jsonRequest('/dashboard/api/jobs/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: req.device,
        period: req.period ?? 'this_month',
        limit: req.limit ?? 6,
      }),
    })
  },

  /**
   * GET /dashboard/api/audit?limit=N
   *   resp: AuditResponse
   */
  audit(limit?: number): Promise<AuditResponse> {
    const qs = limit !== undefined
      ? `?${new URLSearchParams({ limit: String(limit) }).toString()}`
      : ''
    return jsonRequest<AuditResponse>(`/dashboard/api/audit${qs}`)
  },

  /**
   * GET /dashboard/api/diff?since=ISO
   *   resp: DiffResponse
   */
  diff(since: string): Promise<DiffResponse> {
    const qs = new URLSearchParams({ since }).toString()
    return jsonRequest<DiffResponse>(`/dashboard/api/diff?${qs}`)
  },

  /**
   * GET /dashboard/api/ticket?sorszam=…
   *   resp: TicketDetails
   *
   * Full ticket details for one sorszam — customer, devices, all notes,
   * technician, kategoria / sulyossag, dates. Powers the ticket
   * inspector (drawer) and the in-place ticket panel. Throws 404
   * ApiErrorBody if the sorszam is unknown.
   */
  getTicketBySorszam(sorszam: string): Promise<TicketDetails> {
    const qs = new URLSearchParams({ sorszam }).toString()
    return jsonRequest<TicketDetails>(`/dashboard/api/ticket?${qs}`)
  },

  /**
   * GET /dashboard/api/tokens
   *   resp: TokensResponse
   */
  tokens(): Promise<TokensResponse> {
    return jsonRequest<TokensResponse>('/dashboard/api/tokens')
  },

  /**
   * POST /dashboard/api/tokens/rotate
   *   body: (none — server rotates whichever token the session owns)
   *   resp: TokenRotateResponse
   */
  rotateToken(): Promise<TokenRotateResponse> {
    return jsonRequest<TokenRotateResponse>('/dashboard/api/tokens/rotate', {
      method: 'POST',
    })
  },

  /**
   * POST /dashboard/api/approvals/:id
   *   body: { approved: boolean }
   *   resp: ApprovalResponse
   */
  resolveApproval(id: string, approved: boolean): Promise<ApprovalResponse> {
    return jsonRequest<ApprovalResponse>(
      `/dashboard/api/approvals/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      },
    )
  },

  /**
   * GET /dashboard/api/stream  (SSE)
   *   returns a real EventSource so the consumer can attach 'message' /
   *   'error' / named-event listeners directly. EventSource has its own
   *   state machine — do NOT wrap it in a promise.
   */
  stream(): EventSource {
    return new EventSource('/dashboard/api/stream', { withCredentials: true })
  },

  // -------------------------------------------------------------------------
  // Feedback (Ask like / dislike + suggest-correct-answer)
  // -------------------------------------------------------------------------
  // Every call carries the X-Cmms-Uid header — the cmms-api side
  // requires it on POST /v1/feedback/vote, GET /v1/feedback/my-votes,
  // and POST /v1/feedback/correction. For the public counters call
  // (GET /v1/feedback/counters) the X-Cmms-Uid is also sent but the
  // server ignores it (counters are anonymous).
  //
  // The cmms-uid is browser-stable (localStorage-backed; see
  // lib/feedback.ts) — same browser tab sees the same id on reload.
  // The server uses it for dedup (one vote per uid per answer) and
  // to track which uid submitted which correction.

  /**
   * GET /v1/feedback/counters
   *   Public — no auth needed. Returns all-time like/dislike totals.
   */
  loadFeedbackCounters(): Promise<FeedbackCounters> {
    return jsonRequest<FeedbackCounters>('/dashboard/api/feedback/counters', {
      headers: { 'X-Cmms-Uid': getOrCreateCmmsUid() },
    })
  },

  /**
   * POST /v1/feedback/vote
   *   hdr:  X-Cmms-Uid: <UUID>     (required)
   *   body: { answer_id, vote, reason? }
   *   resp: { ok, vote, answer_id }
   */
  submitFeedbackVote(req: FeedbackVoteRequest): Promise<FeedbackVoteResponse> {
    return jsonRequest<FeedbackVoteResponse>('/dashboard/api/feedback/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cmms-Uid': getOrCreateCmmsUid() },
      body: JSON.stringify(req),
    })
  },

  /**
   * GET /v1/feedback/my-votes?answer_ids=a,b,c
   *   hdr:  X-Cmms-Uid             (required)
   *   resp: { votes: { [answer_id]: 1 | -1 } }
   */
  loadMyVotes(answerIds: string[]): Promise<FeedbackMyVotesResponse> {
    const qs = new URLSearchParams({ answer_ids: answerIds.join(',') }).toString()
    return jsonRequest<FeedbackMyVotesResponse>(`/dashboard/api/feedback/my-votes?${qs}`, {
      headers: { 'X-Cmms-Uid': getOrCreateCmmsUid() },
    })
  },

  /**
   * GET /v1/feedback/my-corrections?answer_ids=a,b,c
   *   hdr:  X-Cmms-Uid             (required)
   *   resp: { corrections: { [answer_id]: { correction, created_at } } }
   *
   * Batched read of this user's "share correct answer" submissions
   * for the given answer_ids. The Ask page uses this to hydrate the
   * "Visszajelzés elküldve" state for every rendered bubble in a
   * single round-trip — same pattern as loadMyVotes.
   */
  loadMyCorrections(answerIds: string[]): Promise<FeedbackMyCorrectionsResponse> {
    const qs = new URLSearchParams({ answer_ids: answerIds.join(',') }).toString()
    return jsonRequest<FeedbackMyCorrectionsResponse>(
      `/dashboard/api/feedback/my-corrections?${qs}`,
      { headers: { 'X-Cmms-Uid': getOrCreateCmmsUid() } },
    )
  },

  /**
   * POST /v1/feedback/correction
   *   body: { answer_id, correction }
   *   hdr:  X-Cmms-Uid             (required)
   *   resp: { ok, answer_id, correction, created_at }
   *
   * The user submits free-text "what the answer should have been".
   * Latest wins (UPSERT). Capped at 1000 chars server-side.
   */
  submitFeedbackCorrection(req: FeedbackCorrectionRequest): Promise<FeedbackCorrectionResponse> {
    return jsonRequest<FeedbackCorrectionResponse>('/dashboard/api/feedback/correction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cmms-Uid': getOrCreateCmmsUid() },
      body: JSON.stringify(req),
    })
  },
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Returns the singleton `api` object. Pure factory — no reactive state,
 * no Pinia, no per-call setup. The shape is stable for Phase 5's
 * `useQuery({ queryFn: () => useApi().answer(req) })` pattern.
 */
export function useApi() {
  return api
}
