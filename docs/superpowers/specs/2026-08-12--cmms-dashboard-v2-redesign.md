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
- No mobile-first redesign (this is an operator tool used on a 1280+ wide screen). Mobile is "not broken" not "polished."
- No SSR. Pure client SPA.

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
- Assistant message: `bg-sky-500/[0.06] border border-sky-500/20 rounded-2xl rounded-tl-md px-4 py-3`. Top-right confidence pill (high=emerald, med=amber, low=rose) in `font-mono text-[10px]`. Body via a `renderAnswer()` component that maps `{intent, primitive, results, evidence, follow_ups}` → typed UI. Follow-up chips below as small sky-500/15 pills. A `details/summary` "Other interpretations (2)" expansion.
- Evidence rail: `w-80` panel (right, ≥ 1024px), sticky, lists cited sorszams. Each row: `sorszam font-mono text-sky-500/90` + 1-line snippet in `text-xs text-text-muted`. On `< 1024px` collapses to an inline accordion below the answer.
- Sticky input bar: `h-16 px-6 bg-canvas-2/95 backdrop-blur border-t border-border-subtle`. Input `h-10 flex-1`. Submit `h-10 px-4 rounded-full bg-sky-500 text-canvas font-medium hover:bg-sky-400 active:scale-[0.98]`. Disabled when empty or in-flight.

**Error:** inline `bg-rose-500/10 border border-rose-500/30 rounded-md px-4 py-3 text-sm text-rose-200` with `Retry` button. No raw JSON.

### 5.2 Page 2 — Live Stream (`/dashboard/stream`)

**Layout:** compact top bar + dense scrolling feed.

- **Compact ask banner**: `h-10` input, no example chips. Submits to `/v1/answer`. Answer renders in a collapsible section below the feed, with a `Show in Ask →` link that switches tabs.
- **Filter chips**: segmented `All | Questions | Approvals` (default `All`).
- **Live counter**: `Live · N events` `text-xs font-mono text-text-muted` top-right. Clicking `Pause` freezes the stream.
- **Event rows**:
  - `border-b border-border-subtle px-6 py-3 hover:bg-surface-2/50 transition-colors duration-150`.
  - Timestamp `w-20 font-mono text-xs text-text-muted` (tabular nums).
  - 2px left border: sky-500 for `question`/`answer`, **amber-500 for `approval`**, rose on errors.
  - Type label `w-20 font-mono text-xs uppercase tracking-wider text-text-secondary` (`QUESTION`, `ANSWER`, `APPROVAL`).
  - Body 1 line in `text-sm text-text-primary`, truncated with tooltip on hover.
  - Approval rows get a second row with the prompt and Approve / Reject buttons (`h-7 px-2.5 text-xs rounded-md bg-emerald-500/15 text-emerald-300` / `bg-rose-500/15 text-rose-300`).
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
  - Edges: between machines sharing ≥ 1 customer, 1px `rgba(255,255,255,0.10)`, fade to 0.25 sky-500 on hover.
  - Click: side sheet from the right (or modal on `< md`) with the device's top 5 tickets (sorszam + 1-line snippet) and a `View all in Ask →` link.
  - Hover: floating tooltip card `bg-canvas-2 border border-border-subtle rounded-md p-3 text-xs shadow-lg shadow-black/40`, follows the mouse with 60ms transition.
- **Loading state:** skeleton overlay (3–4 pulsing rounded-rect placeholders sized like nodes) + a 2px sky-500 progress bar across the top of the canvas.
- **Error state:** full-canvas centered `EmptyState` with rose icon, `text-md font-medium` title ("Connection error"), `text-sm text-text-muted` description (parses `{error, detail, hint}` into a human sentence: "HTTP 503 — cmms-api is reloading after deploy. Try again in a minute."), and a `Retry` button.
- **Empty state (no nodes for period):** "No data in this period" + "Broaden the time range" button.

### 5.4 Page 4 — Diff / Revert (`/dashboard/diff`)

**Layout:** title row + control bar + scrollable list of change entries, each rendered as a code-diff block.

- **Title row:** same pattern as Map.
- **Since picker:** native `<input type="datetime-local">`, `h-9 px-3 rounded-md bg-surface border border-border-default font-mono text-sm text-text-primary`. Preset chips to the right: `1h` / `24h` / `7d` / `30d` / `All` (clicking sets the picker to `now - duration` and auto-submits). `Load diff` button `h-9 px-4 rounded-md bg-sky-500 text-canvas font-medium text-sm`, disabled while fetching (shows a spinner).
- **Change entry card:**
  - Container: `border-b border-border-subtle px-6 py-4`.
  - Header: timestamp `w-44 font-mono text-xs text-text-muted` + action badge + tool/primitive + sorszam. Action badge `inline-flex h-5 items-center rounded-full px-2 font-mono text-[10px] uppercase tracking-wider` — `bg-surface-2 text-text-secondary` default, `bg-amber-500/15 text-amber-300` for `approval`, `bg-sky-500/15 text-sky-300` for `answer`, `bg-rose-500/15 text-rose-300` for errors.
  - Diff body: `<pre class="bg-canvas-2 border border-border-subtle rounded-md p-3 font-mono text-xs leading-relaxed">`. `+` lines: `bg-emerald-500/[0.08] text-emerald-200 border-l-2 border-emerald-500/50`. `-` lines: `bg-rose-500/[0.08] text-rose-200 border-l-2 border-rose-500/50`. Context lines unstyled.
  - Action row: `Revert this change` shown only if the server returns `revertable: true` (today nothing is, so it's hidden and replaced by `text-xs text-text-muted` "Revert available via the API"). `View ticket →` always shown, opens the sorszam in the Ask page.
- **Empty state:** centered icon + "No changes in this window" + "Broaden the time range" button.
- **Error state:** same overlay pattern as Map.

### 5.5 Page 5 — Token Portal (`/dashboard/tokens`)

**Layout:** title row + header actions + token panel + audit log table.

- **Title row:** same pattern as Map.
- **Header actions:**
  - `Show current tokens` (primary, `h-9 px-4 rounded-md bg-sky-500 text-canvas font-medium text-sm`): toggles the token panel.
  - `Rotate read token` (ghost/destructive, `h-9 px-4 rounded-md border border-amber-500/30 text-amber-300 hover:bg-amber-500/10 text-sm`): opens a confirm dialog. If the server returns 501 with a manual-instructions note, surface the note in the dialog so the user isn't confused.
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
  - Click row → modal showing the full JSON of the audit entry.
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
The server returns `{ error: "cmms-api unavailable", hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute." }` on every endpoint when ETL is mid-rebuild. This is **the** most common operator-facing error. All pages detect this exact `error` string and:
- Show an inline amber warning (not a full error) with the hint text and an auto-retry countdown ("Retrying in 12s…").
- Backoff: 5s, 15s, 30s, 60s, then stop and require manual retry.
- Implemented in `useApiWithRetry()` composable.

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
│  │  ├─ index.ts              # router setup (history mode)
│  │  ├─ AskPage.vue
│  │  ├─ StreamPage.vue
│  │  ├─ MapPage.vue
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
- `/dashboard/ask` and `/dashboard/ask/` → serve `dashboard-v2/dist/index.html` (SPA fallback for the history-mode router).
- `/dashboard/ops` and `/dashboard/ops/` → 301 to `/dashboard/stream`.
- `/dashboard/assets/*` → serve `dashboard-v2/dist/assets/*` directly.
- `DASHBOARD_PASSWORD` env-var path stays the same; cookie auth stays the same.
- `loadHtml('ask/index.html')` and `loadHtml('dashboard.html')` calls removed; old HTML files deleted.

---

## 8. Build & deploy

### Dependencies

**runtime:** `vue@^3.4`, `vue-router@^4.3`, `@tanstack/vue-query@^5`, `pinia@^2.1`, `cytoscape@^3.28`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`.

**dev:** `vite@^5`, `@vitejs/plugin-vue@^5`, `tailwindcss@^3.4`, `autoprefixer`, `postcss`, `typescript@^5.4`, `vue-tsc@^2`.

### `vite.config.ts` highlights

- `base: '/dashboard/'` so all built assets resolve under the dashboard path.
- `manualChunks: { cytoscape: ['cytoscape'] }` so the Cytoscape bundle is only loaded by the Map route.
- `target: 'es2020'`, `minify: 'esbuild'`, `cssCodeSplit: true`.

### Build command

`cd cmms-api/dashboard-v2 && bun run build` → `cmms-api/dashboard-v2/dist/`.

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

## 9. Open questions (none blocking)

All key decisions were confirmed with the user before this spec was written:

| Decision | Choice |
|---|---|
| Stack | Vue 3 + Vite + Tailwind |
| Scope | All 5 pages, unified shell |
| Accent | sky-500 |
| Fonts | Inter + JetBrains Mono via `@fontsource-variable` |
| Map library | Cytoscape.js |
| Deploy target | Bun serves the Vite dist (replace legacy) |
| Router | vue-router 4 |
| Data layer | TanStack Query (vue-query) |
| App shell approach | Top nav only, segmented style |

No open questions remain. The implementation plan will pick file-level tasks, but the design is settled.

---

## 10. Acceptance criteria

1. A new operator navigating to `/dashboard` lands on Ask and can submit a question; the response renders as typed UI (intent badge, primitive badge, results list, evidence rail), not raw JSON.
2. All 5 routes are reachable from the unified topbar; the active route is visually indicated.
3. The Live Stream page shows live events with a colored left border; approvals are visually distinct; the Ask input is one click away.
4. The Spatial Map renders a force-directed Cytoscape graph with at least 20 nodes for `last_30_days`; clicking a node opens a side sheet; the empty/error states never show raw JSON.
5. The Diff page renders code-diff colored bodies (`+`/`-` lines) with a "Since" picker; the empty/error states are human-readable.
6. The Token Portal shows current tokens on demand, rotates with a confirm dialog, and renders the audit log as a sticky-header table with color-coded action badges.
7. `cmms-api unavailable` triggers an inline amber warning with 5/15/30/60s auto-retry on every page.
8. Keyboard shortcuts (`g a`, `g s`, `g m`, `g d`, `g t`, `Cmd+K`, `?`, `Esc`) work and are documented in the `?` modal.
9. Lighthouse accessibility score ≥ 95; all interactive elements have visible focus rings; `prefers-reduced-motion: reduce` is honored.
10. Total added weight to the cmms-mcp binary: zero (the dashboard is a static dist served by the same Bun process; the dist is on disk).
