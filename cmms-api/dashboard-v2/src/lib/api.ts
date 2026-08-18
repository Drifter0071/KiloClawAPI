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

/**
 * Slim view of a ticket surfaced to the chat as a clickable card.
 * Mirrors the server-side `AgentTicketCard` — see
 * `cmms-api/src/lib/agent.ts`. The full ticket (with all notes,
 * evidence, contacts) is fetched on-demand when the user opens the
 * card; we only ship what the chat needs to render a card.
 */
export interface AgentTicketCard {
  sorszam: string;
  reported_at_iso: string | null;
  status: 'open' | 'closed' | null;
  customer_name: string | null;
  device: string | null;
  kategoria: string | null;
  kategoria_inferred: string | null;
  sulyossag_inferred: string | null;
  snippet: string | null;
}

/** Top-level response from `POST /v1/answer-agent`. */
export interface AnswerAgentResponse {
  final_text: string;
  tool_trace: AgentTraceStep[];
  iterations: number;
  model: string;
  /** Customer the deterministic router resolved (feeds chat threads). */
  resolved_customer: string | null;
  language: "hu" | "en";
  /**
   * Structured ticket list from the agent's last successful
   * answer_question call. The dashboard renders these as clickable
   * cards below the LLM's prose. The LLM only sees a digest, so the
   * cards are the source of truth for the full list — the LLM's
   * prose never has to enumerate >4 items.
   */
  ticket_cards?: AgentTicketCard[];
  /**
   * Server-generated ULID stamped on this answer by the cmms-api
   * snapshot hook (src/routes/agent.ts). Used by the like/dislike
   * bar to identify the row in `feedback_answers`. Optional for
   * back-compat with the legacy deterministic answer (which has no
   * snapshot) and with mock data in tests.
   */
  answer_id?: string;
}

/** Request body for `POST /v1/answer-agent`. */
export interface AnswerAgentRequest {
  q: string;
  language: "hu" | "en";
}

// ---------------------------------------------------------------------------
// 2. Map endpoint — GET /dashboard/api/map
//    Re-projects /v1/jobs/stats (group_by=machine_type, evidence_per_group=2)
//    for Cytoscape. Source: cmms-api/dashboard/server.ts:967-1040.
//    The proxy sets `include_evidence: true` so each top-N group ships
//    up to 2 sample tickets. For low-volume machine types whose group
//    falls outside the top-N (or which the upstream evidence pass simply
//    skipped), `samples` is undefined; the inspector handles that with
//    an on-demand /v1/jobs/search fallback (see MapNodeInspector.vue).
// ---------------------------------------------------------------------------

/** A sample ticket attached to a map node. */
export interface MapSample {
  sorszam: string;
  snippet: string;
  kategoria: string | null;
  kategoria_inferred: string | null;
  sulyossag_inferred: string | null;
  /** ISO timestamp of the original report; null on older rows. Optional
   *  because not every code path that synthesises a sample populates it. */
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
// 2b. Jobs search — POST /v1/jobs/search (no dashboard proxy yet; the
//     map inspector calls it directly). Source: cmms-api/src/routes/jobs.ts
//     lines 32-83. The endpoint accepts a `device` filter that matches
//     the device field with the cache's hyphen-insensitive regex, so
//     "Forg.kihord" / "Forg.kih.spir" / "Forg.sz" all roll up under the
//     same family. We also accept `period` so the same window the user
//     picked on the map applies here.
// ---------------------------------------------------------------------------

/** One ticket row from /v1/jobs/search. Mirrors the upstream JobCard
 *  (after _haystack is stripped) — the inspector only needs a handful
 *  of fields but we declare the full surface so the type stays useful
 *  if a future caller needs more. */
export interface JobCardSummary {
  /** Internal integer key (== cmms.db `data.KEY`). */
  key: number;
  /** Public ticket id, e.g. "B26071801". */
  sorszam: string;
  /** Reported date as a human string (Hungarian formatting) or null. */
  reported_at: string | null;
  reported_at_iso: string | null;
  /** "open" or "closed". */
  status: "open" | "closed";
  /** Technician initials, or null. */
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

/** Response from /v1/jobs/search. */
export interface JobsSearchResponse {
  total: number;
  offset: number;
  limit: number;
  period: AnswerPeriod | null;
  jobs: JobCardSummary[];
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
// 8b. Feedback (Ask like / dislike).
//   POST /dashboard/api/feedback/vote
//     body:  { answer_id, vote, reason? }
//     hdr:   X-Cmms-Uid
//     resp:  FeedbackVoteResponse
//   GET  /dashboard/api/feedback/my-votes?answer_ids=a,b,c
//     resp:  FeedbackMyVotesResponse
//   GET  /dashboard/api/feedback/counters
//     resp:  FeedbackCounters
//
// The admin surface (disliked list, settings) lives on
// /dashboard/api/admin/feedback/* and is gated by the admin cookie;
// it is NOT exposed through useApi — see useAdminFeedback instead.
// ---------------------------------------------------------------------------

export interface FeedbackVoteResponse {
  ok: true;
  vote: 1 | -1;
  answer_id: string;
}

export interface FeedbackMyVotesResponse {
  /** Map of answer_id -> vote. Only includes answers the current uid
   *  has actually voted on; an empty map is a 200, not a 404. */
  votes: Record<string, 1 | -1>;
}

export interface FeedbackCounters {
  likes: number;
  dislikes: number;
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
