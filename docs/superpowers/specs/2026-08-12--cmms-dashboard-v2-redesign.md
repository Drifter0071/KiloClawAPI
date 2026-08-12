# CMMS Dashboard v2 — Visual & UX Redesign

**Date:** 2026-08-12
**Status:** Approved design, pending implementation plan
**Owner:** Gergely Garvan
**Scope:** Replace the two legacy `cmms-api/dashboard/*.html` files with a single Vue 3 + Vite + Tailwind application served from the existing `cmms-mcp` process. No backend changes, no new dependencies on the server, no new ports.

---

## 1. Context & motivation

The current operator dashboard at `https://nctmechanic.shares.zrok.io/dashboard/` is served by `cmms-api/dashboard/server.ts` and consists of two vanilla HTML+JS single-page files:

- `cmms-api/dashboard/ask/index.html` — the Ask chat surface (already mobile-first, decent).
- `cmms-api/dashboard/dashboard.html` — the legacy 4-tab ops dashboard at `/dashboard/ops/` (Live Stream, Spatial Map, Diff/Revert, Token Portal). Raw tech-demo look: empty cards, raw JSON dumps, fragmented top nav, no real visual system.

The two surfaces are served under different URLs and feel like two different products. The user wants them unified into one dashboard that feels like a premium developer tool (Vercel / Supabase / Linear).

### Goals

1. **One product, one chrome.** A single `h-14` top nav that lives above all 5 pages.
2. **Premium dev-tool aesthetic.** Dark, dense, keyboard-friendly, near-black canvas, electric blue accent.
3. **No raw JSON in the UI, ever.** Map errors, diff errors, and Ask errors all render as proper empty/error components.
4. **Reuse, don't rewrite, the backend.** The existing `/dashboard/api/*` routes are the source of truth. No new endpoints, no breaking changes.
5. **Self-host the $70/mo KiloClaw replacement.** This dashboard is the in-house alternative.

### Non-goals

- No new MCP tools, no new REST endpoints, no DB schema changes.
- No light-mode toggle. Dark-only.
- No mobile-first redesign. Minimum supported width is **1280px**; between 768px and 1279px the topbar collapses to a hamburger + drawer; below 768px the layout is single-column with the mobile drawer. Operator tool, desktop-first.
- No SSR. Pure client SPA.

### 2.1 Verified server contracts (read these before implementing)

These were cross-checked against the existing codebase (`cmms-api/src/routes/answer.ts`, `cmms-api/src/routes/jobs.ts`, `cmms-api/dashboard/server.ts`, `cmms-api/src/lib/score.ts`). Implementers should not re-derive them.

**`POST /v1/answer` response shape** — used by the Ask page (`renderAnswer()`):
- Top-level: `q`, `language` ("hu"|"en"), `intent`, `primitive`, `group_by` (nullable), `filters`, `period: {token, resolved_token, date_from, date_to, label_en, label_hu} | null`, `summary` (string, one-sentence hu/en), `follow_ups` (string[]), `results` (array), `evidence` (`Record<string, EvidenceTicket[]>`), `total` (number), `rationale` (string), `mode` (**exactly** `"answer" | "confirm"`), `confidence` (**0..1**, clamped), `threshold` (0..1), `candidates: Array<{rank, intent, primitive, score, score_breakdown, family, filters, period, summary, follow_ups, results, evidence, total, rationale}>`, `mode_rationale` (string).
- `EvidenceTicket`: `{sorszam, key, reported_at_iso, snippet, kategoria, kategoria_inferred, sulyossag_inferred}`.
- `candidates[].family` is one of `"customer" | "time" | "recurring" | "integration" | "other"` — use it as the section header for the "Other interpretations" expander.
- `candidates[].summary` is the field name (not `preview`), and each candidate carries its **own** `results` and `evidence` (not just the top one).

**`POST /v1/jobs/stats` request/response** — used by the Map page:
- Body: `{group_by, period, include_evidence, limit, ...filters}`. Valid `group_by` includes `"customer" | "device" | "machine_type" | "controller" | "kategoria" | ...` (12 values total, see `jobs.ts:88`).
- For the Map we use `group_by: "machine_type"`, `limit: 20`. The dashboard's `/api/map` proxy at `server.ts:381` **must** set `include_evidence: true` so sample tickets are returned for the side sheet (today it sets `false` — that has to change).
- Response: `{period, results: Array<{name, count, ...}>, total, ...}`. Each `name` becomes a Cytoscape node; `count` drives the node size.

**Confidence pill cutoffs** (used by `renderAnswer()`):
- `confidence >= 0.60` → emerald (`high`).
- `0.40 <= confidence < 0.60` → amber (`med`).
- `confidence < 0.40` → rose (`low`).
- Threshold source: `cmms-api/src/lib/score.ts:75` (`DEFAULT_THRESHOLD = 0.60`).

**Confirm mode UX** (when `mode === "confirm"`):
- The winning candidate's `summary` is shown, but the answer body is replaced by a "I think you meant: *<intent>* — is that right?" prompt with two buttons: `[Yes, run it]` (synthesizes the plan from the candidate and refetches) and `[No, refine]` (clears the input and focuses it).
- If `mode === "answer"`, render the full body via `renderAnswer()` as designed.

**`/api/diff` reality** — the server endpoint is a stub (`server.ts:413-429`) that filters the in-memory audit log by `since` and `action ∈ ["approval","answer"]`, returning `[{entity, id, action, t, before: null, after: e.detail}]`. **There is no real diff data.** v2 ships the page as a *structured change log*: each row renders the `after` text in monospace inside the card body, with the action badge and a "View ticket →" link. There are no `+`/`-` lines. Acceptance criterion 5 is updated to reflect this. A real code-diff feature is a follow-up, out of scope.

**`/api/map` reality** — the spec's "edges between machines sharing customers" is **dropped** from v2. The cache has the data (`cache.allJobs()` knows every customer↔device pair), but no endpoint exposes it and the non-goal "no new endpoints" rules out adding one. The Cytoscape graph ships as **nodes only** with a force-directed layout. The "shared customers" idea is captured as a *follow-up* in §9. Acceptance criterion 4 is updated to "renders all machine types returned, gracefully scales 1–48 nodes, no edges in v1."

**`/api/stream` reality** — only `question` and `answer` events are emitted (when this dashboard itself submits a question via `/api/answer`). The `approval` event type and the `approvals` queue are wired (`server.ts:159-171`) but **no producer calls `pushApproval()`** in production — the `mcp-server.ts` never imports it. v2 ships the Approve/Reject button **disabled with a tooltip** ("Approval queue is not yet wired — see follow-up in §9"). The visual style (amber left border, action group) is implemented and will activate when the producer is wired. This is acknowledged in the design — pretending otherwise would mean shipping a button that looks live but does nothing.

**Two-tab SSE** — supported and harmless. Each browser tab holds its own SSE connection; the 5/15/30/60 retry timer is per-call, not per-connection. Two tabs running on a degraded `cmms-api` means 2× the retry traffic, which is trivial. No dedupe needed.

**`useApiWithRetry()` scope** — covers BOTH `error: "cmms-api unavailable"` AND network errors (`TypeError: Failed to fetch`, `code: 'NETWORK_ERROR'`). Both surface the inline amber warning with auto-retry.

---

## 2. Stack & key decisions (locked with the user)

| Decision | Choice | Reason |
|---|---|---|
| Framework | Vue 3 + `<script setup>` SFCs | Matches the user's brief. |
| Build | Vite 5 + `bun` | Already a bun project; Vite is the lightest Vue build. |
| Styling | Tailwind 3.4 + custom tokens | Required by the user; semantic tokens. |
| Fonts | Inter Variable + JetBrains Mono Variable, self-hosted via `@fontsource-variable/*` | Geist-ish look without the Vercel CDN dep. |
| Accent color | sky-500 (#0EA5E9) | Modern, technical, legible on near-black. |
| Map library | Cytoscape.js (interactive node-link graph) | Replaces today's absolute-positioned div grid. |
| Router | vue-router 4 (history mode) | 5 routes, deep-linkable. |
| Data layer | `@tanstack/vue-query` v5 | Caching, retries, deduplication. |
| Cross-component state | Pinia 2 | One store: the live SSE event log. |
| Deploy target | Bun serves the Vite dist | No new process, no new port, ships with `deploy-mcp.ts`. |
| Legacy URLs | Replaced (no fallback) | `/dashboard/ops/*` 301s to the new route, old HTML files deleted. |

---

## 3. Design tokens

### 3.1 Colors (semantic Tailwind theme extension)

```
canvas          : #050608   /* page background, near-black */
canvas-2        : #0B0D12   /* alt for split panes / sticky input */
surface         : #0F1218   /* raised panels — cards, table rows, map canvas */
surface-2       : #151A22   /* hover state on surface */
border-subtle   : rgba(255,255,255,0.06)  /* table dividers */
border-default  : rgba(255,255,255,0.10)  /* input borders, card edges */
border-strong   : rgba(255,255,255,0.16)  /* focused input */
text-primary    : #E5E7EB   /* slate-200 */
text-secondary  : #94A3B8   /* slate-400 */
text-muted      : #64748B   /* slate-500 */
text-inverse    : #0B0D12   /* text on sky-500 fills */
accent          : #0EA5E9   /* sky-500 — primary actions, active tab, focus */
accent-hover    : #38BDF8   /* sky-400 */
accent-glow     : rgba(14,165,233,0.20)  /* focus ring, pulse */
success         : #10B981   /* connected, approved */
warning         : #F59E0B   /* needs approval, reconnecting */
danger          : #F43F5E   /* errors, rejected, revert */
```

**Rules:**
- `accent` is the only color allowed on interactive surfaces (buttons, focus, active nav).
- No gradients on the body. A single 1px `border-subtle` separates the navbar from the workspace.
- Status colors only appear in left borders, badges, and status dots — never as a fill on a full button.

### 3.2 Typography

```
font-sans : "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif
font-mono : "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace

text-xs    : 11px / 1.4     /* badges, table caption */
text-sm    : 12.5px / 1.45  /* table body, form labels, audit log */
text-base  : 14px / 1.5     /* default UI */
text-md    : 15px / 1.5     /* chat messages, evidence cards */
text-lg    : 17px / 1.5     /* page H1 */
text-xl    : 20px / 1.35    /* page H1 hero */
text-2xl   : 28px / 1.2     /* Ask hero "Ask the CMMS" */
```

- Weights: 400 body, 500 labels/captions, 600 headings only.
- `font-feature-settings: "tnum"` on table cells.
- `font-mono` is mandatory for: sorszam (M26057), tokens, audit-log details, diff bodies, timestamps, IDs.
- Fonts imported in `main.ts` via `@fontsource-variable/*`; preloaded with `<link rel="preload">` in `index.html`.

### 3.3 Spacing & radius

- Base unit: 4px. Values come from `[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16]`.
- Card padding: `p-4` (16px). Section padding: `p-6` (24px). Page padding: `px-8 py-6`.
- Radius: `rounded-md` (6px) for inputs/buttons, `rounded-lg` (10px) for cards, `rounded-full` for the connection dot, segmented nav, badges. No `rounded-2xl`.
- Tables: 36px row height, `text-xs` font, sticky header in `surface-2`.

### 3.4 Motion

- Default transition: `duration-150 ease-out` on background, border, color, opacity, transform.
- Tap feedback: `active:scale-[0.98]` on primary buttons.
- Focus ring: `focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:border-sky-500`.
- Streaming item entry: `translateY(4px) opacity-0 → translateY(0) opacity-1`, 200ms.
- Connection dot pulse: 2s, only when `state === 'connected'`.
- `prefers-reduced-motion: reduce` strips all transitions, keeps just opacity for state changes.

### 3.5 Shadows

- `shadow-sm` for the navbar (subtle drop, not a glow).
- `shadow-lg shadow-black/40` for Cytoscape tooltips and modals.
- **No** `shadow-2xl` on cards. Borders do the work.

---

## 4. App shell & navigation

### 4.1 Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  [▣ CMMS API v0.6.0]  Ask Stream Map Diff Tokens  [● Live] [OP▾] [⎋] │  ← topbar (h-14, sticky, surface+blur)
├─────────────────────────────────────────────────────────────────┤
│                       <router-view />                           │  ← workspace, canvas
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Topbar zones

1. **Brand** (`w-56`): inline-SVG logo mark (20×20, 2px sky-500 stroke, sky-500/20 fill, 1 dot center) + wordmark "**CMMS API**" in `text-sm font-semibold` + version chip `text-[10px] font-mono text-text-muted`.

2. **Primary nav** (centered-ish, `gap-1`): **segmented control** style. Single container `bg-surface rounded-full p-1` with one pill per route. Each link `px-3 py-1.5 text-sm rounded-full text-text-secondary hover:text-text-primary`. Active link `bg-surface-2 text-text-primary`. A 1.5px sky-500 dot to the left of the active label. Keyboard hints:
   - `Tab` moves between links, `Enter` activates.
   - `g a` / `g s` / `g m` / `g d` / `g t` (Vim-style chord) jumps to Ask / Stream / Map / Diff / Tokens.

3. **Right cluster** (`gap-3`):
   - **ConnectionStatus**: `h-7 px-2.5 rounded-full bg-surface border border-border-subtle text-xs font-mono`. 6px circle (sky-500/amber/rose) + status text. Pulse animation on the sky dot only.
   - **Operator menu**: button "OP ▾", `h-7 px-2.5`, opens a tiny dropdown (operator label + divider + "Sign out").
   - No notifications bell, no theme toggle.

### 4.3 Mobile behavior (< 768px)

- Topbar collapses to: logo + connection dot + a hamburger.
- The hamburger opens a full-width drawer containing the nav links stacked vertically + the operator menu at the bottom.
- "Sign out" is a full-width destructive-styled button inside the drawer.
- `md:hidden` / `hidden md:flex` toggles between the two states.

### 4.4 Shell-level error handling

- 401 from any `/dashboard/api/*` → toast top-center, rose border, "Session expired — sign in again", 1.5s later `router.push('/dashboard')`.
- Cookie expired but no recent request → full-screen "Sign in to continue" with one primary button.
- 503 with `error: "cmms-api unavailable"` → page-level empty state with auto-retry (see §6.1).

---

## 5. Pages

### 5.1 Page 1 — Ask (`/dashboard/ask`)

**Layout:** 3-zone vertical split, no sidebar.

**Empty state (first visit):**
- Centered, `max-w-2xl mx-auto`, vertical center.
- Headline `text-2xl font-semibold` "Ask the CMMS", subtitle `text-sm text-text-muted` "Hungarian + English, both OK."
- Command bar: input `h-14 px-5 rounded-full bg-surface border border-border-default focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15`. Right side: `kbd`-styled `↵` chip.
- 4 example chips below: `M26057 vezérlés`, `Top ügyfelek tavaly`, `Kritikus ticketek most`, etc. Pill style `h-8 px-3 rounded-full bg-surface border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border-strong`.

**After first ask:**
- User message: `max-w-[85%] self-end bg-surface border border-border-subtle rounded-2xl rounded-br-md px-4 py-2.5 text-md`. Timestamp `font-mono text-[11px] text-text-muted` to the right.
- Assistant message: `bg-sky-500/[0.06] border border-sky-500/20 rounded-2xl rounded-tl-md px-4 py-3`. Top-right confidence pill in `font-mono text-[10px]` — `≥0.60` emerald (`high`), `0.40–0.59` amber (`med`), `<0.40` rose (`low`).
- If `mode === "answer"`: body via `renderAnswer()` (a `lib/renderAnswer.ts` module) that maps `{intent, primitive, results, evidence, follow_ups}` → typed UI. Follow-up chips below as small sky-500/15 pills.
- If `mode === "confirm"`: the body is replaced by a "I think you meant *<intent>* — is that right?" prompt with two buttons: `[Yes, run it]` (re-submits the winning candidate's intent as a fresh `/v1/answer` call) and `[No, refine]` (clears the input and focuses it).
- Below the assistant message, a `details/summary` "Other interpretations (2)" expansion. Each alternate row shows `candidates[i].intent`, `candidates[i].primitive`, `score` as a percent (`(score * 100).toFixed(0)%`), and `candidates[i].summary`. The `candidates[i].family` field becomes the section header (e.g. "Other customer-grouping interpretations").
- Evidence rail: `w-80` panel (right, ≥ 1024px), sticky, lists cited sorszams. Each row: `sorszam font-mono text-sky-500/90` + 1-line snippet in `text-xs text-text-muted`. On `< 1024px` collapses to an inline accordion below the answer.
- Sticky input bar: `h-16 px-6 bg-canvas-2/95 backdrop-blur border-t border-border-subtle`. Input `h-10 flex-1`. Submit `h-10 px-4 rounded-full bg-sky-500 text-canvas font-medium hover:bg-sky-400 active:scale-[0.98]`. Disabled when empty or in-flight.

**Error:** inline `bg-rose-500/10 border border-rose-500/30 rounded-md px-4 py-3 text-sm text-rose-200` with `Retry` button. No raw JSON.

### 5.2 Page 2 — Live Stream (`/dashboard/stream`)

**Layout:** compact top bar + dense scrolling feed.

- **Compact ask banner**: `h-10` input, no example chips. Submits to `/v1/answer`. The answer renders in a collapsible section below the event feed. The `Show in Ask →` link does `router.push('/dashboard/ask', { state: { seedQ: q } })` — the Ask page picks up `seedQ` on mount, focuses its input, and submits. This keeps the Ask page's chat history as the single source of truth for past questions; submitting from the Stream page never creates a parallel history.
- **Filter chips**: segmented `All | Questions | Approvals` (default `All`).
- **Live counter**: `Live · N events` `text-xs font-mono text-text-muted` top-right. Clicking `Pause` freezes the stream.
- **Event rows**:
  - `border-b border-border-subtle px-6 py-3 hover:bg-surface-2/50 transition-colors duration-150`.
  - Timestamp `w-20 font-mono text-xs text-text-muted` (tabular nums).
  - 2px left border: sky-500 for `question`/`answer`, **amber-500 for `approval`**, rose on errors.
  - Type label `w-20 font-mono text-xs uppercase tracking-wider text-text-secondary` (`QUESTION`, `ANSWER`, `APPROVAL`).
  - Body 1 line in `text-sm text-text-primary`, truncated with tooltip on hover.
  - Approval rows get a second row with the prompt and Approve / Reject buttons (`h-7 px-2.5 text-xs rounded-md bg-emerald-500/15 text-emerald-300` / `bg-rose-500/15 text-rose-300`). **In v1, both buttons render `disabled` with a tooltip** "Approval queue not yet wired" — the server route is there, but no producer calls `pushApproval()` in production. The visual treatment is fully implemented so the buttons activate the moment a producer is wired. See §9.
- **Empty state:** centered `Waiting for incoming requests…` with the same triple-dot typing indicator used on Ask.
- **SSE disconnected:** thin amber banner below the topbar: `Stream disconnected — last event 14m ago. Retrying in the background.`

### 5.3 Page 3 — Spatial Map (`/dashboard/map`)

**Layout:** title row + control bar + Cytoscape canvas filling the rest.

- **Title row:** `h-12 px-6 flex items-center justify-between border-b border-border-subtle`. Title `text-md font-semibold`, subtitle `text-xs text-text-muted` (separator `·`).
- **Period selector:** segmented control, 4 pills (`This month` / `Last 30 days` / `Last year` / `All`). Auto-submits on change (vue-query key = `period`). No separate "Refresh" button. A small icon-only refresh button on the right of the title row spins during refetch.
- **Cytoscape canvas:** `flex-1 bg-surface relative`, with a 24px grid background using `linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)`.
  - Layout: `cose` (force-directed) with `nodeRepulsion: 80000`, `idealEdgeLength: 100`, `gravity: 0.25`, `animate: true`.
  - Nodes: 20–48px circles sized by `tickets` (capped). Fill by `getNodeColor(tickets)`: emerald if < 3, amber if 3–9, rose if ≥ 10. Stroke 1px `border-strong`, hover bumps to 2px sky-500.
  - Labels: machine type below the node, `font-mono text-[10px] text-text-secondary`.
  - **No edges in v1.** (v1 ships nodes-only; a future endpoint exposing the customer↔machine matrix would let us draw edges. Tracked in §9.)
  - Click: side sheet from the right (or modal on `< md`) with the device's top 2 sample tickets (sorszam + 1-line snippet) and a `View all in Ask →` link. The samples come from `cache.sampleTickets()` — the proxy must send `include_evidence: true`.
  - Hover: floating tooltip card `bg-canvas-2 border border-border-subtle rounded-md p-3 text-xs shadow-lg shadow-black/40`, follows the mouse with 60ms transition.
- **Loading state:** skeleton overlay (3–4 pulsing rounded-rect placeholders sized like nodes) + a 2px sky-500 progress bar across the top of the canvas.
- **Error state:** full-canvas centered `EmptyState` with rose icon, `text-md font-medium` title ("Connection error"), `text-sm text-text-muted` description (parses `{error, detail, hint}` into a human sentence: "HTTP 503 — cmms-api is reloading after deploy. Try again in a minute."), and a `Retry` button.
- **Empty state (no nodes for period):** "No data in this period" + "Broaden the time range" button.

### 5.4 Page 4 — Diff / Revert (`/dashboard/diff`)

**Layout:** title row + control bar + scrollable list of change entries, each rendered as a code-diff block.

- **Title row:** same pattern as Map.
- **Since picker:** native `<input type="datetime-local">`, `h-9 px-3 rounded-md bg-surface border border-border-default font-mono text-sm text-text-primary`. Preset chips to the right: `1h` / `24h` / `7d` / `30d` / `All` (clicking sets the picker to `now - duration` and auto-submits). On submit the client converts the picker value to a UTC ISO string via `new Date(picker.value + ":00Z").toISOString()` — this assumes the operator's browser and the server are in the same timezone (Hungary, CET/CEST), which is true today. If the operator ever travels, swap in a hidden offset capture; for v1 this is documented in `lib/diff.ts`. `Load diff` button `h-9 px-4 rounded-md bg-sky-500 text-canvas font-medium text-sm`, disabled while fetching (shows a spinner).
- **Change entry card:**
  - Container: `border-b border-border-subtle px-6 py-4`.
  - Header: timestamp `w-44 font-mono text-xs text-text-muted` + action badge + tool/primitive + sorszam. Action badge `inline-flex h-5 items-center rounded-full px-2 font-mono text-[10px] uppercase tracking-wider` — `bg-surface-2 text-text-secondary` default, `bg-amber-500/15 text-amber-300` for `approval`, `bg-sky-500/15 text-sky-300` for `answer`, `bg-rose-500/15 text-rose-300` for errors.
  - Body: `<pre class="bg-canvas-2 border border-border-subtle rounded-md p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">` rendering the `after` text from the audit log. **No `+`/`-` line coloring in v1** — the server stub doesn't return a real diff. The body is just monospace text.
  - Action row: `Revert this change` shown only if the server returns `revertable: true` (today nothing is, so it's hidden and replaced by `text-xs text-text-muted` "Revert available via the API"). `View ticket →` always shown, opens the sorszam in the Ask page.
- **Empty state:** centered icon + "No changes in this window" + "Broaden the time range" button.
- **Error state:** same overlay pattern as Map.

### 5.5 Page 5 — Token Portal (`/dashboard/tokens`)

**Layout:** title row + header actions + token panel + audit log table.

- **Title row:** same pattern as Map.
- **Header actions:**
  - `Show current tokens` (primary, `h-9 px-4 rounded-md bg-sky-500 text-canvas font-medium text-sm`): toggles the token panel.
  - `Rotate read token` (ghost/destructive, `h-9 px-4 rounded-md border border-amber-500/30 text-amber-300 hover:bg-amber-500/10 text-sm`): opens a confirm dialog. **In v1, the server returns 501** with a manual-instructions note (`update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts`). The dialog surfaces that note verbatim and offers a `Copy instructions` button — making the button a *documentation shortcut*, not a broken action. A small `Manual steps only` caption sits next to the button so the operator knows the state up front.
- **Token panel** (visible after Show):
  - Each row: label `w-28 text-xs text-text-muted` + token `font-mono text-sm text-text-primary` (truncated to prefix `cmms_••••abcd`) + `Copy` button (`h-7 w-7`, success flash on click) + `Created` date `text-xs text-text-muted`.
  - Container: `bg-surface border border-border-subtle rounded-lg p-4 space-y-2`.
- **Audit log table:**
  - Wrapper: `bg-surface border border-border-subtle rounded-lg overflow-hidden mt-4`.
  - Header row: `sticky top-0 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle`. Cells `px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium`.
  - Columns: `Time` (w-40, font-mono, tabular nums) · `Action` (w-28, badge) · `Tool` (w-36, font-mono text-xs) · `User` (w-20) · `Details` (flex, text-sm text-text-secondary, truncate with tooltip).
  - Action badge colors:
    - `Login` → `bg-emerald-500/15 text-emerald-300`
    - `Logout` → `bg-slate-500/15 text-slate-300`
    - `Login failed` → `bg-rose-500/15 text-rose-300`
    - `Question` → `bg-sky-500/15 text-sky-300`
    - `Answer` → `bg-violet-500/15 text-violet-300`
    - `Approval` → `bg-amber-500/15 text-amber-300`
    - `Revert request` → `bg-rose-500/15 text-rose-300`
  - Row hover: `hover:bg-surface-2/60 transition-colors duration-150`.
  - Click row → modal showing the audit entry as a two-column key/value list (`t`, `action`, `tool`, `user`, `detail` each as a labeled row in monospace). **No raw JSON in the UI, ever** — this is the only place a user can drill in, and it stays formatted.
  - Footer: `Showing 20 of N entries` + `Load more` link (vue-query paginates by mutating `limit`).
  - Auto-refresh every 10s while the tab is visible (vue-query `refetchInterval`).
- **Empty state:** single centered row `text-text-muted text-sm` "No audit entries yet" with a clock icon.
- **Loading state:** 8 skeleton rows, alternating opacity 0.5/0.8.

---

## 6. Cross-cutting behavior

### 6.1 Error state system

| Level | When | Container | Title color | Icon | Action |
|---|---|---|---|---|---|
| Inline warning | Soft failure (partial results, low confidence) | `bg-amber-500/[0.06] border border-amber-500/20 rounded-md px-4 py-3` | `text-amber-200` | 16px triangle | `Retry` or `Dismiss` |
| Inline error | Hard failure of a single call | `bg-rose-500/[0.08] border border-rose-500/30 rounded-md px-4 py-3` | `text-rose-200` | 16px circle-X | `Retry` + `Copy error details` |
| Page-level empty | API down, auth lost, feature not implemented | Full-pane centered card: 48px icon + `text-lg font-semibold` title + `text-sm text-text-muted` description + button row | icon color = severity | bigger variant | Primary + secondary |

**Special case: `cmms-api unavailable`.**
The server returns `{ error: "cmms-api unavailable", hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute." }` on every endpoint when ETL is mid-rebuild. This is **the** most common operator-facing error.
- A **global amber banner** lives at the bottom of the topbar (`h-9 px-6 bg-amber-500/[0.08] border-b border-amber-500/20 text-amber-200 text-xs flex items-center gap-3`). It shows the hint text and a "Retrying in 12s…" countdown. Because it's in the shell, it covers every page automatically.
- Per-page inline errors still render for non-503 failures (e.g. a 404 on a specific ticket). The global banner only fires for the `cmms-api unavailable` shape.
- Backoff: 5s, 15s, 30s, 60s, then stop and require manual retry. Implemented in `useApiWithRetry()` composable.
- Two browser tabs are harmless — each holds its own retry timer; total retry traffic is at most 2× a single tab.

### 6.2 Empty state system

At most 3 per page, all centered, all in the same family:
- **First-visit:** typography-driven, no illustration, primary CTA.
- **Filtered to zero:** "No data in this period" + "Broaden the time range" button.
- **Error:** see §6.1.

### 6.3 Loading state system

- **Within a card:** shimmer skeleton, 1.4s linear gradient, `rounded-md`. Disabled on `prefers-reduced-motion`.
- **Full page (route change, initial fetch):** 2px sky-500 progress bar pinned to the top of the workspace, 200ms `translateX(-100%) → 100%` then fade. Pulse if fetch > 800ms.
- **Streaming content (Live Stream, Ask):** triple-dot typing indicator (3 sky-500 dots, 1.2s pulse with 150ms stagger).

### 6.4 Keyboard shortcuts

Implemented in a `useKeyboardShortcuts()` composable:
- `g a` / `g s` / `g m` / `g d` / `g t` → jump routes.
- `?` → open the keyboard-shortcut modal.
- `Cmd/Ctrl+K` → focus the Ask input; if not on Ask, also route to it.
- `Esc` → close any open modal / sheet / dropdown.
- Shortcuts ignored when an `<input>`, `<textarea>`, or `<select>` is focused (except `Esc`).

### 6.5 Focus & a11y

- All interactive elements: `focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:border-sky-500`.
- Skip-to-content link at the top of the body, visible on first Tab.
- All icons that convey meaning have `aria-label`; decorative icons have `aria-hidden="true"`.
- All form inputs have associated `<label>` (visually hidden if needed).
- Color is never the only signal: every status-colored element also has a text label or an icon.
- `prefers-reduced-motion: reduce` honored throughout.

### 6.6 Data layer (vue-query + SSE)

- vue-query owns all discrete fetches via `useQuery` for `/api/answer`, `/api/map`, `/api/diff`, `/api/audit`, `/api/tokens`.
- A single module-scoped `useEventSource('/api/stream')` composable owns the SSE connection (one per browser tab). Pages read events through `useStreamEvents()`. The page does **not** refetch the audit log on every SSE event — vue-query's `refetchInterval` is the source of truth; SSE is transient state in a Pinia store.
- The `cmms-api unavailable` retry logic lives in `useApiWithRetry()` (§6.1).

---

## 7. File structure

```
cmms-api/dashboard-v2/
├─ index.html
├─ vite.config.ts
├─ tailwind.config.ts
├─ postcss.config.js
├─ tsconfig.json
├─ package.json
├─ src/
│  ├─ main.ts                  # createApp, plugins, router, queryClient, fonts
│  ├─ App.vue                  # <AppShell> + <router-view />
│  ├─ shell/
│  │  ├─ AppShell.vue
│  │  ├─ AppTopbar.vue
│  │  ├─ AppNav.vue
│  │  ├─ ConnectionStatus.vue
│  │  └─ OperatorMenu.vue
│  ├─ routes/
│  │  ├─ index.ts              # router setup (history mode) — all routes lazy-loaded
│  │  ├─ AskPage.vue
│  │  ├─ StreamPage.vue
│  │  ├─ MapPage.vue           # only route that imports cytoscape
│  │  ├─ DiffPage.vue
│  │  └─ TokensPage.vue
│  ├─ components/              # shared atoms
│  │  ├─ Button.vue
│  │  ├─ Input.vue
│  │  ├─ SegmentedControl.vue
│  │  ├─ Badge.vue
│  │  ├─ EmptyState.vue
│  │  ├─ ErrorState.vue
│  │  ├─ Skeleton.vue
│  │  ├─ Toast.vue
│  │  ├─ Modal.vue
│  │  ├─ Drawer.vue
│  │  └─ DiffBlock.vue
│  ├─ composables/
│  │  ├─ useApi.ts             # typed fetch wrapper
│  │  ├─ useApiWithRetry.ts    # 5/15/30/60 backoff for cmms-api-down
│  │  ├─ useEventSource.ts
│  │  ├─ useStreamEvents.ts
│  │  └─ useKeyboardShortcuts.ts
│  ├─ stores/
│  │  └─ stream.ts             # Pinia: live SSE event log
│  ├─ lib/
│  │  ├─ api.ts                # typed request/response shapes
│  │  ├─ renderAnswer.ts       # {intent, primitive, results, evidence} -> UI
│  │  └─ cytoscape.ts          # node/edge factories + color thresholds
│  └─ styles/
│     ├─ tokens.css            # CSS custom properties (1:1 with tailwind theme)
│     └─ base.css              # resets, font-face, body bg
```

### `cmms-api/dashboard/server.ts` edits

- `/dashboard` (no trailing path) → 302 to `/dashboard/ask`.
- `/dashboard/ask`, `/dashboard/ask/`, `/dashboard/stream`, `/dashboard/map`, `/dashboard/diff`, `/dashboard/tokens` → serve `dashboard-v2/dist/index.html` (SPA fallback for the history-mode router). The serve helper MUST return a 503 with a clear "build not deployed" page when `dashboard-v2/dist/index.html` is missing — see the "First-deploy failure mode" subsection below.
- `/dashboard/assets/*` → serve `dashboard-v2/dist/assets/*` directly.
- `/dashboard/ops` and `/dashboard/ops/` → 301 to `/dashboard/stream`.
- `DASHBOARD_PASSWORD` env-var path stays the same; cookie auth stays the same. The other agent's bearer-token fallback (`checkBearer()`) is merged in unchanged.
- `loadHtml('ask/index.html')` and `loadHtml('dashboard.html')` calls removed; old HTML files deleted. The PWA assets at `cmms-api/dashboard/ask/manifest.json` and `cmms-api/dashboard/ask/sw.js` are also **deleted** — v2 drops PWA support, and serving `index.html` in response to a `manifest.json` fetch would break the browser's PWA install prompt. If PWA support is needed later, it can be re-added against the new build output.

---

## 8. Build & deploy

### Dependencies

**runtime:** `vue@^3.4`, `vue-router@^4.3`, `@tanstack/vue-query@^5`, `pinia@^2.1`, `cytoscape@^3.28`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`.

**dev:** `vite@^5`, `@vitejs/plugin-vue@^5`, `tailwindcss@^3.4`, `autoprefixer`, `postcss`, `typescript@^5.4`, `vue-tsc@^2`.

### `vite.config.ts` highlights

- `base: '/dashboard/'` so all built assets resolve under the dashboard path.
- `manualChunks: { cytoscape: ['cytoscape', 'cytoscape-cose', './src/lib/cytoscape.ts'] }` — Cytoscape, the cose layout extension, and the project's cytoscape helpers all go in the same chunk, only imported by MapPage. MapPage itself is loaded with `component: () => import('./MapPage.vue' /* webpackChunkName: "map" */)` so the chunk is fetched on first navigation, not at app boot.
- `target: 'es2020'`, `minify: 'esbuild'`, `cssCodeSplit: true`.

### Build command

`cd cmms-api/dashboard-v2 && bun run build` → `cmms-api/dashboard-v2/dist/`.

### Local dev workflow

`bun run --cwd cmms-api/dashboard-v2 dev` runs Vite on `http://localhost:5173`. The dashboard server is on `127.0.0.1:8788`, so the `vite.config.ts` must include:

```ts
server: {
  port: 5173,
  proxy: {
    "/dashboard/api": { target: "http://127.0.0.1:8788", changeOrigin: false, cookieDomainRewrite: "localhost" },
    "/dashboard/login": { target: "http://127.0.0.1:8788", changeOrigin: false },
  },
}
```

With this proxy, dev cookies set by `:8788` carry across to `:5173` (the rewrite normalizes the cookie domain). The operator logs in once via the existing login form; subsequent API calls use the cookie. Bearer-token fallback (the other agent's `checkBearer()` work) is a separate dev escape hatch if the operator is calling the API from a non-browser context (e.g. a curl smoke test) and is not required for the Vue dev workflow.

### First-deploy failure mode

If `/opt/cmms-api/dashboard-v2-dist/index.html` is missing on the server (failed build, failed SFTP, never deployed), the new `serveDashboardIndex()` helper in `server.ts` must return a 503 with a clear message and a `Retry` link, **not** an empty 200 and **not** a `loadHtml`-style placeholder. The expected body is:

```html
<!doctype html><meta charset="utf-8">
<title>Dashboard not deployed</title>
<style>body{font-family:system-ui;background:#050608;color:#E5E7EB;padding:48px;}</style>
<h1>Dashboard build is missing</h1>
<p>Expected <code>/opt/cmms-api/dashboard-v2-dist/index.html</code> on 10.0.3.81.</p>
<p>Run <code>bun run deploy-dashboard-v2.ts</code> from the dev machine.</p>
```

This avoids the silent 200 + blank page that the legacy `loadHtml()` placeholder produces.

### Deploy (new `cmms-api/deploy-dashboard-v2.ts`)

1. Build locally: `bun run --cwd cmms-api/dashboard-v2 build`.
2. SFTP `dist/` to `/opt/cmms-api/dashboard-v2-dist/` on `10.0.3.81`.
3. The `server.ts` change is part of `deploy-mcp.ts` (single small file edit). After upload, restart `cmms-mcp.service`.
4. No DB changes, no `cmms-api` binary changes.
5. Rollback: `ssh root@10.0.3.81 'rm -rf /opt/cmms-api/dashboard-v2-dist && ln -s /opt/cmms-api/dashboard-v2-dist.prev /opt/cmms-api/dashboard-v2-dist'` (deploy keeps `.prev` on every run).

### Testing

- 1 new test file: `cmms-api/dashboard-v2/tests/build.test.ts` — asserts the build produces `dist/index.html` and the asset manifest references the expected chunks.
- No new backend tests (server routes unchanged).
- Manual smoke checklist:
  1. Log in at `/dashboard`.
  2. Hit each of the 5 routes.
  3. Confirm `/dashboard/ops/` redirects to `/dashboard/stream`.
  4. Trigger a `cmms-api unavailable` (e.g. briefly stop the API) and confirm the auto-retry UI shows up.
  5. Open a Cytoscape node, confirm the side sheet shows tickets.
  6. Submit a diff request, confirm the code-diff formatting.
  7. Open the audit log, confirm badges color-coded correctly.

---

## 9. Follow-ups (out of scope for v1, captured so they don't get lost)

These are features the design assumes but does not ship in v1 because they need new server work, new data, or new producer wiring:

1. **Map edges** — once an endpoint exposes the customer↔machine matrix (e.g. `GET /v1/jobs/customer-machine-matrix?period=...`), draw edges between machines that share ≥ 1 customer. The Cytoscape code path and the side-sheet code path are unchanged; only the node factory needs a second fetch + an edge factory.
2. **Approval queue producer** — wire `pushApproval()` and the `emitStreamEvent({type: "approval", ...})` from `mcp-server.ts` hot paths (likely the tool wrappers for `create_ticket`, `close_ticket`, `modify_ticket`, `add_ticket_tag` for high-severity operations). The dashboard side is already done — the disabled Approve/Reject buttons activate the moment a producer calls into the approval queue.
3. **Real diff source** — replace the audit-log stub at `cmms-api/dashboard/server.ts:413` with a real `git`-style diff (e.g. a daily snapshot of the spec DB, or a direct row-level diff against the `_meta.last_change_at` watermark). The dashboard side renders the existing `+`/`-` line coloring as soon as `before` and `after` are non-null structured objects.
4. **PWA support** — re-add the manifest + service worker against the new build output if the operator wants "Add to Home Screen" on a tablet. Dropped in v1 because the legacy PWA assets were tangled with the old HTML serving path.
5. **Audit log rotation** — `server.ts:139-142` synchronously appends to `AUDIT_LOG_PATH` on every event. High-volume `login`/`question` events grow the file unbounded. v1 inherits the legacy behavior; a future PR should add a daily rotation policy (compress to `audit.log.YYYY-MM-DD.gz` after 7 days, delete after 90).

---

## 10. Acceptance criteria

1. A new operator navigating to `/dashboard` lands on Ask and can submit a question; the response renders as typed UI (intent badge, primitive badge, results list, evidence rail), not raw JSON.
2. All 5 routes are reachable from the unified topbar; the active route is visually indicated.
3. The Live Stream page shows live events with a colored left border; approvals are visually distinct; the Ask input is one click away.
4. The Spatial Map renders a force-directed Cytoscape graph of all machine types returned by the API (gracefully scales 1–48 nodes, no edges in v1); clicking a node opens a side sheet with the top 2 sample tickets; the empty/error states never show raw JSON.
5. The Diff page renders a structured change log (timestamp, action badge, monospace body, `View ticket →` link) with a "Since" picker; the empty/error states are human-readable. **No `+`/`-` line coloring in v1** — that ships when a real diff source is added.
6. The Token Portal shows current tokens on demand, rotates with a confirm dialog, and renders the audit log as a sticky-header table with color-coded action badges.
7. `cmms-api unavailable` triggers an inline amber warning with 5/15/30/60s auto-retry on every page.
8. Keyboard shortcuts (`g a`, `g s`, `g m`, `g d`, `g t`, `Cmd+K`, `?`, `Esc`) work and are documented in the `?` modal.
9. Lighthouse accessibility score ≥ 95; all interactive elements have visible focus rings; `prefers-reduced-motion: reduce` is honored.
10. Total added weight to the cmms-mcp binary: zero (the dashboard is a static dist served by the same Bun process; the dist is on disk).
