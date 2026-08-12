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
}

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
