// src/lib/api.ts
//
// Typed wire-shape definitions for every CMMS Dashboard v2 endpoint.
// Pure TypeScript — no runtime code, no imports. Source of truth for
// the field names and shapes is docs/superpowers/specs/2026-08-12--
// cmms-dashboard-v2-redesign.md §2.1 (verified server contracts) and
// the proxy code in cmms-api/dashboard/server.ts (lines 284-430+).
//
// All shapes are server-emitted unless suffixed `Request`. Do NOT
// change a field name without a server-side change — these are the
// public wire contract.

// ---------------------------------------------------------------------------
// 1. Answer endpoint — POST /v1/answer
//    Proxied through /dashboard/api/answer. Source:
//      docs/.../2026-08-12--cmms-dashboard-v2-redesign.md §2.1
//      cmms-api/src/routes/answer.ts
// ---------------------------------------------------------------------------

/** Server's `mode` discriminator for the top-level answer. */
export type AnswerMode = "answer" | "confirm";

/** Candidate "family" used as the section header for the "Other
 *  interpretations" expander on the Ask page. */
export type AnswerCandidateFamily =
  | "customer"
  | "time"
  | "recurring"
  | "integration"
  | "other";

/** Resolved period window — the LLM cites this directly. */
export interface AnswerPeriod {
  token: string;
  resolved_token: string;
  date_from: string; // ISO date (YYYY-MM-DD)
  date_to: string;   // ISO date (YYYY-MM-DD)
  label_en: string;
  label_hu: string;
}

/** Filters applied to the underlying primitive call. */
export interface AnswerFilters {
  customer?: string | null;
  device?: string | null;
  kategoria?: string | null;
  kategoria_inferred?: string | null;
  sulyossag_inferred?: string | null;
  period?: string | null;
  status?: string | null;
  sorszam?: string | null;
  // The server forwards a permissive object; anything else stays open
  // so we don't lose new filter fields the backend adds.
  [k: string]: unknown;
}

/** A single ticket pulled in as evidence for a claim. */
export interface EvidenceTicket {
  sorszam: string;
  key: string;
  reported_at_iso: string; // ISO datetime
  snippet: string;
  kategoria: string | null;
  kategoria_inferred: string | null;
  sulyossag_inferred: string | null;
}

/** Minimal Customer shape returned by /v1/tickets/by-sorszam/:sorszam. */
export interface TicketCustomer {
  name: string;
  zip: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

/** Device entry on a TicketDetails response. `raw` is the original
 *  cmms-device string; the structured fields are the ETL-extracted
 *  pieces (model / software / hardware / servos / controller / type). */
export interface TicketDevice {
  raw: string;
  model: string | null;
  software: string | null;
  hardware: string | null;
  servos: string | null;
  controller: string | null;
  machine_type: string | null;
  freeform: string | null;
}

/** Note attached to a ticket. `kind` discriminates the lifecycle
 *  stage: `reported` = the original fault description, `work` = a
 *  visit/fix entry, `free` = any other attached comment. */
export interface TicketNote {
  kind: "reported" | "work" | "free";
  body: string;
  author: string | null;
  created_at: string | null;
}

/**
 * Full ticket details returned by GET /v1/tickets/by-sorszam/:sorszam
 * (proxied through /dashboard/api/ticket?sorszam=… on the v2 dashboard).
 *
 * Mirrors the server-side `JobCard` (after `_haystack` is stripped):
 * the inspector / panel can show every field the operator needs
 * without an extra round-trip.
 */
export interface TicketDetails {
  key: number;
  sorszam: string;
  reported_at: string | null;
  reported_at_iso: string | null;
  status: "open" | "closed";
  technician: string | null;
  customer: TicketCustomer;
  devices: TicketDevice[];
  notes: TicketNote[];
  problem_kategoria: string | null;
  problem_alkategoria: string | null;
  sulyossag: string | null;
  kategoria_inferred: string | null;
  kategoria_inferred_conf: number | null;
  sulyossag_inferred: string | null;
  sulyossag_inferred_conf: number | null;
  alkategoria_inferred: string | null;
  resolution: string | null;
}

/** One alternative interpretation returned by the router. */
export interface AnswerCandidate {
  rank: number;
  intent: string;
  primitive: string;
  score: number; // 0..1
  score_breakdown?: Record<string, number>;
  family: AnswerCandidateFamily;
  filters: AnswerFilters;
  period: AnswerPeriod | null;
  summary: string;
  follow_ups: string[];
  results: unknown[]; // primitive-specific row shape
  evidence: Record<string, EvidenceTicket[]>;
  total: number;
  rationale: string;
}

/** Top-level response from `POST /v1/answer`. */
export interface AnswerResponse {
  /** Server-stamped ULID for this exact answer. Used as the
   *  foreign-key target for /v1/feedback/vote — every 👍 / 👎 click
   *  is attached to this id. The legacy /v1/answer endpoint stamps
   *  one of these at request time and inserts a feedback_answers row
   *  so the SPA can render the like / dislike footer. */
  answer_id: string;
  q: string;
  language: "hu" | "en";
  intent: string;
  primitive: string;
  group_by: string | null;
  filters: AnswerFilters;
  period: AnswerPeriod | null;
  summary: string; // one-sentence hu or en, per `language`
  /** Optional render-only LLM rewrite of `summary` (present only when
   *  the request had `llm: true` AND a Kilo key is configured; null
   *  otherwise). The deterministic `summary` is never replaced. */
  summary_llm?: string | null;
  follow_ups: string[];
  results: unknown[]; // primitive-specific row shape
  evidence: Record<string, EvidenceTicket[]>;
  total: number;
  rationale: string;
  mode: AnswerMode;
  confidence: number; // 0..1, server-clamped
  threshold: number;  // 0..1 (default 0.60)
  candidates: AnswerCandidate[];
  mode_rationale: string;
}

/** Request body for `POST /v1/answer`. */
export interface AnswerRequest {
  q: string;
  language: "hu" | "en";
  customer?: string;
  device?: string;
  kategoria?: string;
  kategoria_inferred?: string;
  sulyossag_inferred?: string;
  period?: string;
  status?: "open" | "closed" | "all" | string;
  limit?: number;
  /** Render-only LLM rewrite of `summary` (Kilo Gateway). Default off. */
  llm?: boolean;
}

// ---------------------------------------------------------------------------
// 1b. Agent endpoint — POST /v1/answer-agent
//    Proxied through /dashboard/api/answer-agent. The agentic Ask loop:
//    gpt-4o picks and calls the MCP tools itself (answer_question, the
//    deterministic router, first). Hard-fails (502 agent_failed) on any
//    LLM error — no deterministic fallback (user decision 2026-08-13).
//    Source: cmms-api/src/lib/agent.ts + src/routes/agent.ts.
// ---------------------------------------------------------------------------

/** One tool call the agent made while answering. */
export interface AgentTraceStep {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  note?: string;
}

/** Top-level response from `POST /v1/answer-agent`. */
export interface AnswerAgentResponse {
  /** Server-stamped ULID for this exact answer. Used as the
   *  foreign-key target for /v1/feedback/vote — every 👍 / 👎 click
   *  is attached to this id. The /v1/answer-agent endpoint mints a
   *  fresh ULID per run and inserts a feedback_answers row, so the
   *  SPA can render the like / dislike footer. */
  answer_id: string;
  final_text: string;
  tool_trace: AgentTraceStep[];
  iterations: number;
  model: string;
  /** Customer the deterministic router resolved (feeds chat threads). */
  resolved_customer: string | null;
  language: "hu" | "en";
}

/** One prior turn sent for same-thread context carry. Only
 *  `user`/`assistant` roles are accepted; error/correction bubbles
 *  are filtered client-side. */
export interface AgentHistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Machine-scoped ask: a default scope picked BEFORE the question.
 *  Injected server-side as a system message ("use this as the default
 *  scope; the user's own wording takes precedence"). */
export interface AgentContextScope {
  device?: string
  customer?: string
  sorszam?: string
}

/** Request body for `POST /v1/answer-agent` (and its async/stream
 *  variants). */
export interface AnswerAgentRequest {
  q: string
  language: 'hu' | 'en'
  /** Same-thread context carry — prior turns from the active thread. */
  history?: AgentHistoryTurn[]
  /** Machine-scoped ask — default scope picked before the question. */
  context?: AgentContextScope
}

// ---------------------------------------------------------------------------
// 1c. Agent streaming — POST /v1/answer-agent/stream (SSE)
//
// A single `text/event-stream` response. One frame per event, named
// events (`event: <name>\ndata: <json>\n\n`). The final frame is
// `answer` carrying the full AnswerAgentResponse; a definitive agent
// failure arrives as `error` (hard-fail contract — the client shows it,
// it does NOT fall back to a deterministic answer).
// ---------------------------------------------------------------------------

/** `event: status` — loop phase transitions. */
export interface AgentStreamStatusEvent {
  type: 'status'
  phase: 'start' | 'searching' | 'synthesizing' | 'soft_deadline'
}

/** `event: tool_start` — the agent is about to call a tool. */
export interface AgentStreamToolStartEvent {
  type: 'tool_start'
  name: string
  args: Record<string, unknown>
}

/** `event: tool_done` — a tool call finished (ok + compact summary). */
export interface AgentStreamToolDoneEvent {
  type: 'tool_done'
  name: string
  ok: boolean
  note?: string
  summary?: string
}

/** `event: token` — incremental answer text (final round only). */
export interface AgentStreamTokenEvent {
  type: 'token'
  text: string
}

/** `event: answer` — the run completed; carries the full outcome. */
export interface AgentStreamAnswerEvent {
  type: 'answer'
  outcome: AnswerAgentResponse
}

/** `event: error` — the run failed (agent_failed / internal). */
export interface AgentStreamErrorEvent {
  type: 'error'
  code: string
  message: string
}

export type AgentStreamEvent =
  | AgentStreamStatusEvent
  | AgentStreamToolStartEvent
  | AgentStreamToolDoneEvent
  | AgentStreamTokenEvent
  | AgentStreamAnswerEvent
  | AgentStreamErrorEvent

// ---------------------------------------------------------------------------
// 1d. Device suggestions — GET /v1/devices?q=…&limit=…
//    Substring device search for the machine-scope picker. Sorted by
//    ticket count desc (most-relevant machines first).
// ---------------------------------------------------------------------------

export interface DeviceSuggestion {
  name: string
  tickets: number
  /** Best-effort dominant customer for this device (the customer with
   *  the most tickets for the same device in main CMMS). Lets the
   *  operator disambiguate "M17191" the VÁMOSGÉP machine from
   *  "M17191" the same serial at a different shop. null when the
   *  device has no recorded customer. */
  customer_name: string | null
}

export interface DevicesResponse {
  devices: DeviceSuggestion[]
  q: string
  limit: number
}

/**
 * Response of `POST /v1/answer-agent/async` (202): the agent runs as a
 * background job so complex questions can take minutes without tripping
 * the zrok edge's ~60s response cap. The SPA polls `answerAgentPoll`
 * until status becomes "done" / "error".
 */
export interface AnswerAgentJobStart {
  job_id: string;
  status: "running";
}

/** Poll state of one async agent job (`GET /v1/answer-agent/async/:id`). */
export type AnswerAgentJobState =
  | { job_id: string; status: "running"; elapsed_s?: number }
  | { job_id: string; status: "done"; result: AnswerAgentResponse }
  | { job_id: string; status: "error"; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// 2. Map endpoint — GET /dashboard/api/map
//    Re-projects /v1/jobs/stats (group_by=machine_type, limit=20) for
//    Cytoscape. Source: cmms-api/dashboard/server.ts:389-417.
//    NOTE: the proxy currently sets `include_evidence: false`; samples
//    will be absent. The proxy must be flipped to true in Phase 6.2
//    (per spec §2.1 follow-up). Until then, samples is optional.
// ---------------------------------------------------------------------------

/** A sample ticket attached to a map node. */
export interface MapSample {
  sorszam: string;
  snippet: string;
  kategoria: string | null;
  kategoria_inferred: string | null;
  sulyossag_inferred: string | null;
  /** ISO datetime — used by the list-view "last seen" column and the
   *  "recent" sort mode. Optional because some legacy upstream rows
   *  don't carry it. */
  reported_at_iso?: string | null;
}

/** One machine-type node in the spatial map. */
export interface MapNode {
  /** Display label for the node (== raw in current server). */
  model: string;
  /** Original unprocessed name from the stats row. */
  raw: string;
  /** Number of tickets in this group (drives node size). */
  tickets: number;
  /** Optional: 1-2 sample tickets (absent while include_evidence=false). */
  samples?: MapSample[];
}

/** Map response wrapper. */
export interface MapResponse {
  nodes: MapNode[];
  total_groups: number;
  period: AnswerPeriod | null;
}

// ---------------------------------------------------------------------------
// 3. Stream endpoint — GET /dashboard/api/stream (SSE)
//    Discriminated union over the `type` field. Source:
//      cmms-api/dashboard/server.ts:140-144 (StreamEvent shape) and
//      cmms-api/dashboard/server.ts:483-514 (handler).
//    All events carry an ISO timestamp in `t`.
// ---------------------------------------------------------------------------

/** `event: hello` — sent on initial connection. */
export interface StreamHelloEvent {
  type: "hello";
  t: string; // ISO datetime
}

/** `event: question` — emitted when the dashboard posts to /api/answer. */
export interface StreamQuestionEvent {
  type: "question";
  t: string; // ISO datetime
  tool?: string; // typically "answer"
  q: string;    // first 200 chars of the submitted question
}

/** `event: answer` — emitted after the upstream /v1/answer returns. */
export interface StreamAnswerEvent {
  type: "answer";
  t: string; // ISO datetime
  tool?: string; // typically "answer"
  summary: string; // extracted summary (or intent / results length)
}

/** `event: approval` — emitted when an approval is resolved.
 *  (No producer wires `pushApproval()` in production today — see spec
 *  §2.1; the queue is typed so the UI can render when wired.) */
export interface StreamApprovalEvent {
  type: "approval";
  t: string; // ISO datetime
  id: string;
  action: string;
  summary: string; // "APPROVED: ..." or "REJECTED: ..."
}

/** Discriminated union of all SSE event payloads. */
export type StreamEvent =
  | StreamHelloEvent
  | StreamQuestionEvent
  | StreamAnswerEvent
  | StreamApprovalEvent;

// ---------------------------------------------------------------------------
// 4. Audit log — GET /dashboard/api/audit?limit=N
//    Source: cmms-api/dashboard/server.ts:418-423, 146, 151-158.
// ---------------------------------------------------------------------------

/** Known audit action strings. The server is permissive (`action: string`)
 *  but the dashboard only renders these meaningfully. */
export type AuditAction =
  | "login"
  | "logout"
  | "login_failed"
  | "question"
  | "answer"
  | "approval"
  | "acquire_token"
  | "token_rotate_request"
  | "revert_request";

/** A single entry from the in-memory audit log (newest first). */
export interface AuditEntry {
  /** ISO datetime. */
  t: string;
  action: AuditAction | string;
  tool?: string;
  user?: string;
  detail?: string;
}

/** Response wrapper for /api/audit. */
export interface AuditResponse {
  entries: AuditEntry[];
}

// ---------------------------------------------------------------------------
// 5. Diff endpoint — GET /dashboard/api/diff?since=ISO
//    Stub today: filters the audit log by action ∈ {"approval","answer"}
//    and wraps each row. before=null, after=string. Source:
//      cmms-api/dashboard/server.ts:424-440.
// ---------------------------------------------------------------------------

/** A single change-log row from /api/diff. */
export interface DiffChange {
  entity: string;          // e.g. the tool name or "answer"
  id: string;              // audit timestamp for the stub
  action: string;          // "approval" | "answer" (and others later)
  t: string;               // ISO datetime
  before: unknown;         // stub returns null; future: structured
  after: unknown;          // stub returns string (audit detail); future: structured
}

/** Response wrapper for /api/diff. */
export interface DiffResponse {
  changes: DiffChange[];
}

// ---------------------------------------------------------------------------
// 6. Tokens endpoint — GET /dashboard/api/tokens
//    Source: cmms-api/dashboard/server.ts:451-457.
//    All three are 8-char prefixes + "..." or "(unset)" markers.
// ---------------------------------------------------------------------------

export interface TokensResponse {
  read_token_prefix: string;
  write_token_prefix: string;
  bearer_token_prefix: string;
}

// ---------------------------------------------------------------------------
// 7. Token rotate — POST /dashboard/api/tokens/rotate
//    Currently always returns 501; body is { ok: false, note: string }.
//    Source: cmms-api/dashboard/server.ts:458-466.
// ---------------------------------------------------------------------------

export interface TokenRotateResponse {
  ok: false;
  note: string;
}

// ---------------------------------------------------------------------------
// 8. Approvals — POST /dashboard/api/approvals/:id
//    Body: { approved: boolean }. Response: { ok: boolean }.
//    Source: cmms-api/dashboard/server.ts:467-472.
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  approved: boolean;
}

export interface ApprovalResponse {
  ok: boolean;
}

// ---------------------------------------------------------------------------
// 9. Common shapes — errors and the client-side thrown shape.
// ---------------------------------------------------------------------------

/** Wire shape returned by the cmms-api-down 503 path on every proxy. */
export interface ApiError {
  error: string;
  detail?: string;
  hint?: string;
}

/** Shape thrown by useApi.ts on any non-2xx response. */
export interface ApiErrorBody {
  status: number;
  message: string;
  body: unknown; // the parsed JSON body (often an ApiError)
}

// ---------------------------------------------------------------------------
// 9. Feedback (Ask like / dislike + suggest-correct-answer)
// ---------------------------------------------------------------------------
//
// The user-facing vote + counter surface. Admin endpoints
// (/v1/feedback/disliked, /v1/feedback/settings) live in their own
// module (useAdminFeedback.ts) because they require a different
// auth path (admin cookie, not user bearer).

/** All-time like/dislike counters. The public call (no auth) returns this. */
export interface FeedbackCounters {
  likes: number
  dislikes: number
}

/** Wire shape for POST /v1/feedback/vote. */
export interface FeedbackVoteRequest {
  answer_id: string
  vote: 1 | -1
  reason?: string
}

/** Response from POST /v1/feedback/vote. */
export interface FeedbackVoteResponse {
  ok: true
  vote: 1 | -1
  answer_id: string
}

/** Response from GET /v1/feedback/my-votes?answer_ids=a,b,c. */
export interface FeedbackMyVotesResponse {
  /** Sparse map of answer_id → the user's vote (-1 or 1). Missing keys mean no vote. */
  votes: Record<string, -1 | 1>
}

/** Wire shape for POST /v1/feedback/correction. */
export interface FeedbackCorrectionRequest {
  answer_id: string
  /** 1..1000 chars. Server-truncated. */
  correction: string
}

/** Response from POST /v1/feedback/correction. */
export interface FeedbackCorrectionResponse {
  ok: true
  answer_id: string
  correction: string
  created_at: string
}

/**
 * Response from GET /v1/feedback/my-corrections?answer_ids=a,b,c.
 * Mirrors FeedbackMyVotesResponse but for the "I sent my correct
 * answer" follow-up. The map is sparse — missing keys mean "no
 * correction submitted for this answer". Latest correction per
 * (answer_id, uid) pair wins; the server returns only one row.
 */
export interface FeedbackMyCorrectionsResponse {
  corrections: Record<string, { correction: string; created_at: string }>
}
