# CMMS Dashboard v2 — Implementation Plan

**Date:** 2026-08-12
**Spec:** `docs/superpowers/specs/2026-08-12--cmms-dashboard-v2-redesign.md`
**Branch:** `mcp-redesign-phase5` (matches the spec branch; create `mcp-redesign-dashboard-v2` if you want a fresh branch — see §0.1)
**Estimated phases:** 7
**Estimated tasks:** ~50
**Stack:** Vue 3 + Vite 5 + Tailwind 3.4 + TS 5.4 + vue-router 4 + @tanstack/vue-query 5 + Pinia 2 + Cytoscape 3.28 + Inter + JetBrains Mono

---

## 0. How to use this plan

Each phase is a self-contained unit that ends with a verifiable state (a passing test, a running dev server, a deployable artifact). Don't move to phase N+1 until phase N's exit criteria are met. Where a task says "TBD-ask" or "verify X before doing Y", stop and resolve before continuing — those flags exist because I know the spec has at least one cross-cutting dependency (the backend agent's `checkBearer()` work in `cmms-api/dashboard/server.ts`).

**Naming convention:** the project lives in `cmms-api/dashboard-v2/`. All paths in this plan are relative to the repo root unless noted.

**Branch hygiene:** open a fresh branch for this work. If `mcp-redesign-phase5` is the only branch you're using, fine; otherwise:
```bash
git -c core.autocrlf=false checkout -b mcp-redesign-dashboard-v2
```

---

## Phase 1 — Scaffold the project (foundation, no UI yet)

**Goal:** `bun run dev` shows a blank "CMMS API dashboard v2" page on `:5173` that proxies `/dashboard/api/*` to `:8788` correctly.

### 1.1 Verify backend agent's work landed
- `git -c core.autocrlf=false log --oneline cmms-api/dashboard/server.ts | head -10` — confirm the bearer-token fallback `checkBearer()` is committed. If not, **stop here** and ping the backend agent.
- If it's uncommitted on disk, stash-not-merge: `cd cmms-api && bun test` should still pass. If it doesn't, the backend work is broken and v2 can't start.
- **Exit criterion:** `cd cmms-api && bun test` is green.

### 1.2 Create the project tree
- `mkdir cmms-api/dashboard-v2`
- Write `cmms-api/dashboard-v2/package.json` with:
  - name: `dashboard-v2`
  - type: `module`
  - scripts: `dev`, `build`, `preview`, `typecheck`
  - deps (exact ranges — these are what the spec locks):
    ```json
    "vue": "^3.4.0",
    "vue-router": "^4.3.0",
    "@tanstack/vue-query": "^5.0.0",
    "pinia": "^2.1.7",
    "cytoscape": "^3.28.0",
    "@fontsource-variable/inter": "^5.0.0",
    "@fontsource-variable/jetbrains-mono": "^5.0.0"
    ```
  - devDeps: `vite@^5`, `@vitejs/plugin-vue@^5`, `vue-tsc@^2`, `typescript@^5.4`, `tailwindcss@^3.4`, `autoprefixer`, `postcss`
- `cd cmms-api/dashboard-v2 && bun install` — should resolve without warnings.
- **Exit criterion:** `bun install` exits 0.

### 1.3 Vite + TypeScript + Tailwind config
- Write `cmms-api/dashboard-v2/vite.config.ts` with:
  - `base: '/dashboard/'`
  - `server.port: 5173`
  - `server.proxy` per spec §8 (Local dev workflow): `/dashboard/api` and `/dashboard/login` → `http://127.0.0.1:8788` with `cookieDomainRewrite: "localhost"`
  - `build.target: 'es2020'`, `build.minify: 'esbuild'`, `build.cssCodeSplit: true`
  - `build.rollupOptions.output.manualChunks: { cytoscape: ['cytoscape', 'cytoscape-cose'] }` — adjust if `cytoscape-cose` isn't installed (it isn't by default; install it as a dep in 1.4)
  - `resolve.alias: { '@': '/src' }`
- Write `cmms-api/dashboard-v2/tsconfig.json` (extends `vue-tsc` defaults; `paths: { "@/*": ["src/*"] }`, `strict: true`).
- Write `cmms-api/dashboard-v2/tailwind.config.ts` extending the spec §3 tokens:
  ```ts
  theme: {
    extend: {
      colors: {
        canvas: '#050608', 'canvas-2': '#0B0D12',
        surface: { DEFAULT: '#0F1218', 2: '#151A22' },
        'text-primary': '#E5E7EB', 'text-secondary': '#94A3B8', 'text-muted': '#64748B', 'text-inverse': '#0B0D12',
        accent: { DEFAULT: '#0EA5E9', hover: '#38BDF8', glow: 'rgba(14,165,233,0.20)' },
        success: '#10B981', warning: '#F59E0B', danger: '#F43F5E',
      },
      fontFamily: { sans: ['"Inter Variable"', 'system-ui', 'sans-serif'], mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'monospace'] },
      borderRadius: { md: '6px', lg: '10px' },
      transitionDuration: { DEFAULT: '150ms' },
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0, 0, 0.2, 1)' },
    },
  },
  ```
- Write `cmms-api/dashboard-v2/postcss.config.js` with `tailwindcss` + `autoprefixer`.
- **Exit criterion:** `bun run --cwd cmms-api/dashboard-v2 typecheck` exits 0 (it'll pass with an empty `src/`).

### 1.4 Add cytoscape-cose
- `bun add --cwd cmms-api/dashboard-v2 cytoscape-cose` (needed for the force-directed layout in §5.3).
- Update the `manualChunks` entry if needed.
- **Exit criterion:** `bun install` exits 0.

### 1.5 Index.html + main.ts + App.vue (smoke)
- Write `cmms-api/dashboard-v2/index.html` with `<title>CMMS API dashboard</title>`, a `<div id="app">`, and a `<link rel="preload">` for the Inter variable font (the css import will load the rest).
- Write `cmms-api/dashboard-v2/src/main.ts`:
  ```ts
  import { createApp } from 'vue'
  import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
  import { createPinia } from 'pinia'
  import App from './App.vue'
  import '@fontsource-variable/inter'
  import '@fontsource-variable/jetbrains-mono'
  import './styles/tokens.css'
  import './styles/base.css'
  createApp(App).use(createPinia()).use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }) }).mount('#app')
  ```
- Write `cmms-api/dashboard-v2/src/styles/tokens.css` mirroring the tailwind config (one CSS-variable per token) — useful for raw `style="..."` and the Cytoscape style sheet.
- Write `cmms-api/dashboard-v2/src/styles/base.css` with the body bg, the Inter `font-feature-settings: "tnum"` for numeric cells, and the `prefers-reduced-motion` media query from spec §3.4.
- Write `cmms-api/dashboard-v2/src/App.vue` as a placeholder: `<div class="h-screen flex items-center justify-center text-text-muted">CMMS API dashboard v2 — scaffold</div>`.
- **Exit criterion:** `bun run --cwd cmms-api/dashboard-v2 dev` serves a blank styled page on `http://localhost:5173/`. Manual smoke: visit `http://localhost:5173/dashboard/api/audit?limit=5` and confirm the cookies from `:8788` carry across (you should see a JSON response, not a 401).

### 1.6 Add the build test
- Write `cmms-api/dashboard-v2/tests/build.test.ts`:
  - Spawns `bun run build` as a child process
  - Asserts `dist/index.html` exists
  - Asserts the asset manifest (read from `dist/index.html`'s `<script>` tags) references chunks for `AskPage`, `StreamPage`, `MapPage`, `DiffPage`, `TokensPage`, with `MapPage` and Cytoscape in the same chunk
- Wire it into the existing `cmms-api/tests/` runner — add it to `cmms-api/tests/harness.ts` if there's a registry, otherwise add a `bunfig.toml` test pattern.
- **Exit criterion:** `cd cmms-api && bun test` is green and includes the new test.

---

## Phase 2 — App shell + routing

**Goal:** navigating to any of the 5 routes shows the h-14 topbar with the segmented nav, the route name, and an empty workspace. No real page content yet.

### 2.1 Router setup
- Write `cmms-api/dashboard-v2/src/routes/index.ts`:
  ```ts
  import { createRouter, createWebHistory } from 'vue-router'
  export const router = createRouter({
    history: createWebHistory('/dashboard/'),
    routes: [
      { path: '/', redirect: '/ask' },
      { path: '/ask', name: 'ask', component: () => import('./AskPage.vue' /* webpackChunkName: "ask" */) },
      { path: '/stream', name: 'stream', component: () => import('./StreamPage.vue' /* webpackChunkName: "stream" */) },
      { path: '/map', name: 'map', component: () => import('./MapPage.vue' /* webpackChunkName: "map" */) },
      { path: '/diff', name: 'diff', component: () => import('./DiffPage.vue' /* webpackChunkName: "diff" */) },
      { path: '/tokens', name: 'tokens', component: () => import('./TokensPage.vue' /* webpackChunkName: "tokens" */) },
    ],
  })
  ```
- Register it in `main.ts` (`.use(router)` after the others).
- Write the 5 page files as `<template><div class="p-8 text-text-muted">AskPage</div></template>` placeholders.
- **Exit criterion:** `bun run dev`; click each nav link; route changes, no console errors.

### 2.2 App shell
- Write `cmms-api/dashboard-v2/src/shell/AppShell.vue`:
  ```html
  <template>
    <div class="h-screen flex flex-col bg-canvas text-text-primary">
      <AppTopbar />
      <main class="flex-1 overflow-auto"><router-view /></main>
    </div>
  </template>
  ```
- Update `App.vue` to render `<AppShell />` instead of the placeholder.
- **Exit criterion:** all 5 routes render the topbar above a placeholder.

### 2.3 AppTopbar + AppNav
- Write `cmms-api/dashboard-v2/src/shell/AppTopbar.vue` per spec §4.2 — sticky, h-14, `bg-canvas-2/80 backdrop-blur-md border-b border-border-subtle`. Three zones: brand (left), nav (center), right cluster.
- Write `cmms-api/dashboard-v2/src/shell/AppNav.vue` as the segmented control. 5 links. Active state is `bg-surface-2 text-text-primary`; inactive is `text-text-secondary hover:text-text-primary`. Use `useRoute()` and `RouterLink` with `custom` + `v-slot` so you can compute the active state and the sky-500 dot.
- **Exit criterion:** nav visually matches the spec's ASCII sketch at §4.1. Active route is unmistakable. Hover transitions are 150ms.

### 2.4 ConnectionStatus
- Write `cmms-api/dashboard-v2/src/shell/ConnectionStatus.vue`:
  - 3 states: `connected` (sky-500 dot, pulsing), `reconnecting` (amber, no pulse), `disconnected` (rose, no pulse).
  - For now, hardcode `connected` — real SSE integration comes in Phase 4.
  - The pulsing dot uses `animate-pulse` (Tailwind built-in), gated by a `data-state="connected"` attribute and a `@media (prefers-reduced-motion)` override.
- **Exit criterion:** the pill renders with the sky-500 pulsing dot.

### 2.5 OperatorMenu
- Write `cmms-api/dashboard-v2/src/shell/OperatorMenu.vue`:
  - Button `OP ▾` opens a tiny dropdown (operator label from a hardcoded `user` store for now + divider + "Sign out" button that POSTs to `/dashboard/logout`).
  - Click-outside closes it. Esc closes it.
  - Use `@vueuse/core`'s `onClickOutside` (add as a dep) — or hand-roll a small directive if you want one fewer dep.
- **Exit criterion:** dropdown opens, "Sign out" actually logs you out (302 to `/dashboard`).

### 2.6 Mobile drawer
- Add a `useMediaQuery('(min-width: 768px)')` composable (write inline, no @vueuse).
- Below 768px: render a hamburger button in the topbar that toggles a full-width drawer. The drawer contains the 5 nav links stacked + the operator menu at the bottom.
- **Exit criterion:** at 600px viewport, topbar shows logo + status + hamburger; click hamburger, drawer covers the page.

### 2.7 Keyboard shortcuts composable (skeleton)
- Write `cmms-api/dashboard-v2/src/composables/useKeyboardShortcuts.ts` per spec §6.4. Just the chord handler + Esc-to-close + Cmd/Ctrl+K focus. The `?` modal can be a Phase 3 task.
- **Exit criterion:** `g a` jumps to /ask from any page. Esc closes the operator dropdown.

### 2.8 Global "cmms-api unavailable" banner (skeleton)
- Write `cmms-api/dashboard-v2/src/composables/useApiWithRetry.ts` skeleton (real integration in Phase 4 — for now, the banner is hidden).
- Add a `<GlobalBanner />` component to `AppShell.vue` below the topbar. Hidden by default.
- **Exit criterion:** the banner doesn't render in dev (no `cmms-api unavailable` in the data).

---

## Phase 3 — Shared atoms (Button, Input, SegmentedControl, Badge, EmptyState, ErrorState, Skeleton, Toast, Modal, Drawer, DiffBlock)

**Goal:** the design system exists. Every page in Phase 4+ builds from these atoms.

For each component below, write a `.vue` SFC matching the spec's description, plus a single-page test in `cmms-api/dashboard-v2/tests/atoms.test.ts` (vue-test-utils + happy-dom). If the test setup is non-trivial, defer tests to a small dedicated phase (3.0) before starting 3.1.

### 3.0 Test scaffolding (do this first)
- Add `vitest@^1`, `@vue/test-utils@^2`, `happy-dom@^14` as devDeps.
- Write `cmms-api/dashboard-v2/vitest.config.ts`.
- Write `cmms-api/dashboard-v2/tests/atoms.test.ts` with a placeholder `it('passes', ...)` and verify `bun test` finds it.
- **Exit criterion:** test runner works, one passing test.

### 3.1 Button
- Three variants: `primary` (`bg-accent text-text-inverse`), `secondary` (`border border-border-default text-text-primary hover:bg-surface-2`), `ghost` (`text-text-secondary hover:bg-surface-2`).
- Three sizes: `sm` (h-7), `md` (h-9), `lg` (h-10).
- `disabled:opacity-50 disabled:cursor-not-allowed`. Loading state: a tiny spinner replaces the label.
- **Test:** renders all variants, fires click, disabled state, loading state.

### 3.2 Input
- `h-9` (or `h-10` when used as the Ask bar), `px-3 rounded-md`, border, focus ring.
- Slots: leading icon, trailing icon.
- Monospace variant (used for sorszam, tokens, since-picker).
- **Test:** typing fires `update:modelValue`, focus ring visible on focus.

### 3.3 SegmentedControl
- Props: `modelValue: string`, `options: Array<{value, label}>`. Emits `update:modelValue`.
- Renders a `bg-surface rounded-full p-1` container with one pill per option. Active pill `bg-surface-2 text-text-primary`.
- **Test:** click switches value, keyboard arrows work.

### 3.4 Badge
- Variants: `default | success | warning | danger | info` (info = sky). All are `inline-flex h-5 items-center rounded-full px-2 font-mono text-[10px] uppercase tracking-wider`. Each maps to the right bg/text class.
- **Test:** renders all variants with the right classes.

### 3.5 EmptyState
- Props: `icon?` (component), `title` (string), `description?` (string), `actions?` (slot for buttons).
- Centered, with the icon-size-48 convention from spec §6.1.
- **Test:** renders title, description, and a slotted button.

### 3.6 ErrorState
- Like EmptyState but with a `severity: 'warning' | 'error'` prop that picks the right color and icon.
- Includes a `Retry` button if a `retry` callback is passed.
- **Test:** title, description, retry callback fires on click.

### 3.7 Skeleton
- Default `<div class="animate-shimmer rounded-md">` with optional `h` and `w` props. The `shimmer` animation lives in `base.css`.
- Disabled by `prefers-reduced-motion: reduce`.
- **Test:** renders with the right classes.

### 3.8 Toast
- A tiny global toast system: a Pinia store + a `<ToastContainer />` mounted in `AppShell.vue` that renders a stack.
- API: `useToast().error('msg')`, `.warn('msg')`, `.info('msg')`. Each has a 5s auto-dismiss.
- 3 variants use the same color rules as `Badge`.
- **Test:** `useToast().error('x')` adds a toast to the store, container renders it.

### 3.9 Modal
- Slot-based, backdrop click + Esc to close, `transition-opacity duration-150`.
- Sub-components: `<Modal>` (wrapper), `<ModalHeader>`, `<ModalBody>`, `<ModalFooter>`.
- **Test:** opens/closes, Esc works, slot content renders.

### 3.10 Drawer
- Slides in from the right, `w-96 max-w-[90vw]`, Esc + backdrop close.
- Used by the Map side sheet.
- **Test:** opens, closes, slot content renders.

### 3.11 DiffBlock
- Props: `before?: string, after: string`.
- Renders the audit-log-style body. In v1, no `+`/`-` line coloring — just a `<pre class="bg-canvas-2 border border-border-subtle rounded-md p-3 font-mono text-xs whitespace-pre-wrap">`.
- The `+`/`-` line split is scaffolded but commented: `// TODO(follow-up): when /api/diff returns a real diff, split on /^[-+]/m and colorize`. Implementer note: keep the comment in the code so the follow-up is visible.
- **Test:** renders the `after` text in a `<pre>`.

### 3.12 Phase 3 exit
- All atoms in `cmms-api/dashboard-v2/src/components/`, all tests green.
- `cd cmms-api && bun test` is green.

---

## Phase 4 — Data layer + composables

**Goal:** every page can fetch its data with `useQuery`, the SSE stream works, the retry composable handles `cmms-api unavailable`.

### 4.1 `lib/api.ts` — typed request/response shapes
- Define types for every wire shape the dashboard uses:
  - `AnswerResponse` (top-level + `candidates[]`)
  - `MapResponse` (`{ nodes: [{ model, raw, tickets, samples? }] }` — note the spec renames `name` → `model` for the dashboard's Map node payload because that's what the legacy `renderMap()` consumed and the proxy at `server.ts:392` already produces)
  - `AuditEntry` (`{ t, action, tool?, user?, detail? }`)
  - `DiffResponse` (`{ changes: [{ entity, id, action, t, before, after }] }`)
  - `TokensResponse`, `TokenRotateResponse`
  - `StreamEvent` (typed by `type: "hello" | "question" | "answer" | "approval"`)
- **Exit criterion:** no `any` types in the data layer.

### 4.2 `composables/useApi.ts`
- A typed `fetch` wrapper. Reads `credentials: 'same-origin'`, sets `Content-Type: application/json`, throws on `!r.ok` with `{ status, message }`.
- **Test:** throws on 4xx/5xx with the right error shape, succeeds on 2xx.

### 4.3 `composables/useApiWithRetry.ts`
- Wraps a `useQuery`-style callback. Detects `error: "cmms-api unavailable"` (string match) AND `TypeError: Failed to fetch` / `code: 'NETWORK_ERROR'`.
- On detection, surfaces a payload `{ kind: 'cmms-api-down', hint: string }` and starts a 5/15/30/60s backoff.
- Exposes `useGlobalApiState()` (a singleton Pinia store) that the `<GlobalBanner />` reads.
- **Test:** simulated 503 triggers the banner, retry timer fires, manual retry resets the timer.

### 4.4 `composables/useEventSource.ts` + `stores/stream.ts`
- `useEventSource` is a module-scoped EventSource. One connection per browser tab. Auto-reconnects on `error` with the same 5/15/30/60 backoff.
- `stores/stream.ts` is a Pinia store with the live event list (capped at 100). Exposes `events`, `pushEvent(ev)`, `clear()`.
- `composables/useStreamEvents.ts` returns the store's `events` ref.
- **Test:** simulated `EventSource` events populate the store.

### 4.5 Phase 4 exit
- `cd cmms-api && bun test` is green, including 3+ new tests for the data layer.

---

## Phase 5 — Pages

Each page is its own sub-phase. Build them in this order (most-touched first).

### 5.1 AskPage (`/dashboard/ask`)
- Per spec §5.1. Use `useQuery({ queryKey: ['answer', q], queryFn: () => api.post('/v1/answer', { q }) })` triggered manually (don't run on mount).
- Build `lib/renderAnswer.ts`:
  - `renderAnswer(data: AnswerResponse, mode: 'inline' | 'modal')` returns a render-function that produces the right component tree based on `data.intent`, `data.primitive`, `data.results`, `data.evidence`, `data.follow_ups`.
  - The `mode === 'confirm'` branch renders the "I think you meant X" prompt.
  - The `candidates` expander renders `candidates[i].family` as the section header.
- Build the chat history UI: a single `<ChatThread>` component holds the messages (Pinia store `ask.ts`), `<UserMessage>`, `<AssistantMessage>`, `<EvidenceRail>`.
- `<EvidenceRail>` is `w-80` right-rail ≥ 1024px, inline accordion < 1024px.
- Sticky input bar at the bottom.
- Empty state: hero + 4 example chips.
- Loading state: triple-dot typing indicator.
- Error state: `ErrorState` with `severity="error"` and a `Retry` button that re-runs the query.
- **Test:** mount, type, submit, see assistant message, click follow-up chip, submit again, see new history. Mock `useQuery` to return canned data.

### 5.2 StreamPage (`/dashboard/stream`)
- Per spec §5.2. Compact `h-10` Ask banner at top (uses the same `<AskBar>` component as the Ask page, just with a `compact` prop).
- Filter segmented control: `All | Questions | Approvals`.
- Live counter `Live · N events`, with a `Pause` button.
- Event rows: time + type badge + body + actions.
- The `Show in Ask →` link does `router.push('/dashboard/ask', { state: { seedQ: q } })`. Implement a small `useSeedQ()` composable on the Ask page that reads `router.currentRoute.value.state.seedQ` on mount, focuses the input, and submits.
- SSE integration: subscribe to `useStreamEvents()`.
- Approve/Reject buttons: rendered with `disabled` and a `title="Approval queue not yet wired"` tooltip (per the spec's follow-up #2).
- Empty state: `EmptyState` with "Waiting for incoming requests…" and a typing indicator.
- **Test:** mount, simulate SSE events, see rows. Click Pause, see no new rows.

### 5.3 MapPage (`/dashboard/map`)
- Per spec §5.3.
- Title row + period SegmentedControl + manual refresh icon button.
- Cytoscape mount:
  - `lib/cytoscape.ts` exports `makeCyto(selector, options)`, `nodeStyle(tickets)`, `colorByTickets(tickets)`.
  - Layout: `cose` with the spec's parameters.
  - On node click, open a `<Drawer>` from the right with the device's top 2 sample tickets (from `samples[]` in the response).
  - On node hover, show a small floating tooltip card following the mouse.
- Grid background: an absolutely-positioned 24px grid via CSS `background-image`.
- Loading state: `Skeleton` overlay + 2px sky-500 progress bar at the top.
- Error state: `ErrorState` parsing `{ error, detail, hint }` into a human sentence.
- **Test:** mount with mocked `/api/map` data, assert Cytoscape is created with the right nodes (use a real Cytoscape instance — jsdom can't do layout but it can create the graph).

### 5.4 DiffPage (`/dashboard/diff`)
- Per spec §5.4.
- Title row + Since picker (native `datetime-local` + preset chips) + Load diff button.
- Preset chips: `1h | 24h | 7d | 30d | All`. Each computes `now - duration` from the client clock, formats the picker value, and submits. Documented caveat in `lib/diff.ts`.
- Change entry cards: timestamp + action `Badge` + tool + sorszam + `DiffBlock` body + `View ticket →` (uses the same `router.push` seedQ pattern).
- Empty state: `EmptyState` with "No changes in this window".
- Error state: `ErrorState` with retry.
- **Test:** mount, click "24h" preset, see a list of mocked diff entries.

### 5.5 TokensPage (`/dashboard/tokens`)
- Per spec §5.5.
- Title row + header actions (Show current tokens / Rotate read token).
- Token panel: hidden by default, toggled by Show. Each token row has a Copy button with success flash.
- Rotate read token: confirm dialog. The dialog uses the server's 501 note verbatim and offers a `Copy instructions` button.
- Audit log table: 5 columns (Time, Action, Tool, User, Details), sticky header, alternating-action badges per spec.
- Click a row → `Modal` with the audit entry as a 5-row key/value list (`t`, `action`, `tool`, `user`, `detail`). Missing optional fields render `—`.
- Auto-refresh every 10s while the tab is visible (vue-query `refetchInterval: 10000` + `refetchIntervalInBackground: false`).
- **Test:** mount, click Show, see tokens. Click a row, see modal.

### 5.6 Phase 5 exit
- All 5 pages render. Each has at least one test. `cd cmms-api && bun test` is green.
- Manual smoke: visit each page in dev (`bun run dev`), confirm the design matches the spec.

---

## Phase 6 — Server-side wiring (deploy path)

**Goal:** production serves the new dashboard at `/dashboard/ask` etc., legacy routes redirect, old HTML files are gone.

### 6.1 Update `cmms-api/dashboard/server.ts`
- After the bearer-token work from Phase 1.1 has landed, layer in the new dashboard routing:
  - `/dashboard` → 302 to `/dashboard/ask`
  - `/dashboard/ask`, `/dashboard/ask/`, `/dashboard/stream`, `/dashboard/map`, `/dashboard/diff`, `/dashboard/tokens` (and their trailing-slash variants) → serve `dashboard-v2/dist/index.html` via the new `serveDashboardIndex()` helper. The helper:
    - Tries `readFileSync('/opt/cmms-api/dashboard-v2-dist/index.html', 'utf-8')` (configurable via `DASHBOARD_DIST_DIR`).
    - If the file doesn't exist, returns the "build not deployed" 503 page from spec §8.
  - `/dashboard/assets/*` → static serve from `dashboard-v2/dist/assets/*`.
  - `/dashboard/ops`, `/dashboard/ops/` → 301 to `/dashboard/stream`.
  - `/dashboard/api/*` → unchanged.
  - `/dashboard/login` (GET) and `/dashboard/logout` (POST) → unchanged.
  - `/dashboard/ask/manifest.json` and `/dashboard/ask/sw.js` → 404 (PWA assets are deleted; see 6.3).
- Remove `loadHtml('ask/index.html')` and `loadHtml('dashboard.html')` calls.
- **Exit criterion:** `cd cmms-api && bun test` is still green.

### 6.2 Set `include_evidence: true` on `/api/map` proxy
- Edit the `proxy("/v1/jobs/stats", ...)` body at `server.ts:381` to flip `include_evidence: true`.
- This is required for the Map side sheet to populate.
- **Exit criterion:** `curl http://127.0.0.1:8787/dashboard/api/map?period=last_30_days` returns a response with `nodes[*].samples[]`.

### 6.3 Delete legacy assets
- `rm cmms-api/dashboard/ask/index.html cmms-api/dashboard/ask/manifest.json cmms-api/dashboard/ask/sw.js cmms-api/dashboard/dashboard.html`
- `git -c core.autocrlf=false rm` them.
- **Exit criterion:** `git status` shows them removed, no `git ls-files` hit on those paths.

### 6.4 Deploy script
- Write `cmms-api/deploy-dashboard-v2.ts` per spec §8:
  1. `bun run --cwd cmms-api/dashboard-v2 build`
  2. Verify `dist/index.html` exists; abort loudly if not.
  3. SFTP `dist/` to `/opt/cmms-api/dashboard-v2-dist.NEW/` on `10.0.3.81`.
  4. On the server: rotate `/opt/cmms-api/dashboard-v2-dist.prev ← /opt/cmms-api/dashboard-v2-dist`, then `mv` the new dir into place, then `rm -rf` the `.prev` after a 5-minute grace period (so a bad deploy can be rolled back by hand).
  5. `ssh root@10.0.3.81 'systemctl restart cmms-mcp'`.
  6. `ssh root@10.0.3.81 'curl -fsS http://127.0.0.1:8788/dashboard/ask | head -5'` to confirm the server is up.
- **Exit criterion:** the script runs end-to-end against a staging copy of the server (or at least past the SFTP step in dry-run mode).

### 6.5 Hook into `deploy-mcp.ts`
- The `server.ts` change in 6.1 must ship with `cmms-mcp`. Add a one-line step to `deploy-mcp.ts`: after the existing file uploads, run `bun run deploy-dashboard-v2.ts` (or inline the steps).
- **Exit criterion:** running `bun run deploy-mcp.ts` updates both the MCP server and the dashboard dist in one go.

### 6.6 Phase 6 exit
- Local: `bun test` is green.
- The `cmms-api/dashboard/server.ts` change is small enough to review in 5 minutes.
- The deploy script has a dry-run mode and a manual rollback.

---

## Phase 7 — Verification + smoke

**Goal:** every acceptance criterion in spec §10 is true.

### 7.1 Manual smoke checklist (run against the deployed prod)
Run through each of the 10 acceptance criteria from spec §10 and check it off. Any that don't pass → open a follow-up issue, do not "fix in this PR".

1. **AC1** — Visit `/dashboard`. Land on Ask. Submit "M26057 vezérlése". Response renders as typed UI (intent + primitive + results + evidence rail), not raw JSON.
2. **AC2** — Click each of the 5 nav links. Active route is visually indicated.
3. **AC3** — On Stream, see live events. Approvals have a distinct amber left border. The Ask input is at the top of the page.
4. **AC4** — On Map, see a force-directed graph of machine types. Click a node, see the side sheet with sample tickets. Empty/error states are human-readable.
5. **AC5** — On Diff, set "Since" to 1h ago. See change log entries with the `after` text in monospace. No `+`/`-` lines (this is v1).
6. **AC6** — On Tokens, click Show, see token list. Click Rotate, see confirm dialog with the 501 instructions. Audit log table renders with color-coded badges. Click a row, see the key/value modal (not raw JSON).
7. **AC7** — Stop the cmms-api service (`ssh root@10.0.3.81 'systemctl stop cmms-api'`). Reload the dashboard. The global amber banner appears with the 5/15/30/60s auto-retry countdown. Restart the service and watch it recover.
8. **AC8** — Press `g a` from /map, jump to /ask. Press `?`, see the shortcut modal. Press `Cmd+K` from any page, focus the Ask input. Press `Esc`, close any modal.
9. **AC9** — Run Lighthouse on `/dashboard/ask`. Accessibility ≥ 95. Tab through the page — every interactive element has a visible focus ring. Set OS "reduce motion" — animations stop.
10. **AC10** — `ls -la /opt/cmms-api/dashboard-v2-dist/` shows the new dist. `ls -la /opt/cmms-api/cmms-mcp` shows the unchanged binary size (no growth). The cmms-mcp service is still running.

### 7.2 Cross-browser smoke
- Chrome, Firefox, Edge (the operator's likely browsers). The dashboard doesn't need to support Safari but if it breaks there, note it.
- 1280px, 1440px, 1920px widths. Confirm the topbar + Map graph look right at each.
- 1024px (collapsed to mobile drawer). Confirm the hamburger works.

### 7.3 Performance check
- Hard refresh `/dashboard/map`. The Cytoscape chunk should fetch on first navigation, not on initial app boot. Open DevTools Network, confirm the chunk loads when you click Map, not on the first paint of the Ask page.
- Hard refresh `/dashboard/ask`. Time to interactive should be under 1.5s on a warm cache.

### 7.4 Final commit + tag
- `git -c core.autocrlf=false add -A`
- `git -c core.autocrlf=false commit -m "feat(dashboard): v2 redesign — Vue 3 + Vite + Tailwind"`
- Tag: `git -c core.autocrlf=false tag dashboard-v2-v1.0`
- Update the `AGENTS.md` deployment table to mention the new `dashboard-v2` deploy step.

### 7.5 Update memory
- Add a short entry to user memory: "v2 dashboard shipped 2026-08-12. Vue 3 + Vite SPA at /dashboard/. Cytoscape is a code-split chunk. The approval-queue producer is still missing — button is disabled. Real diff data is still missing — page renders audit-log body. Both are tracked as follow-ups in spec §9."

---

## Appendix A — File checklist (all files created or modified)

**Created (dashboard-v2):**
- `cmms-api/dashboard-v2/package.json`
- `cmms-api/dashboard-v2/vite.config.ts`
- `cmms-api/dashboard-v2/tsconfig.json`
- `cmms-api/dashboard-v2/tailwind.config.ts`
- `cmms-api/dashboard-v2/postcss.config.js`
- `cmms-api/dashboard-v2/vitest.config.ts`
- `cmms-api/dashboard-v2/index.html`
- `cmms-api/dashboard-v2/src/main.ts`
- `cmms-api/dashboard-v2/src/App.vue`
- `cmms-api/dashboard-v2/src/styles/tokens.css`
- `cmms-api/dashboard-v2/src/styles/base.css`
- `cmms-api/dashboard-v2/src/shell/AppShell.vue`
- `cmms-api/dashboard-v2/src/shell/AppTopbar.vue`
- `cmms-api/dashboard-v2/src/shell/AppNav.vue`
- `cmms-api/dashboard-v2/src/shell/ConnectionStatus.vue`
- `cmms-api/dashboard-v2/src/shell/OperatorMenu.vue`
- `cmms-api/dashboard-v2/src/shell/GlobalBanner.vue`
- `cmms-api/dashboard-v2/src/routes/index.ts`
- `cmms-api/dashboard-v2/src/routes/AskPage.vue`
- `cmms-api/dashboard-v2/src/routes/StreamPage.vue`
- `cmms-api/dashboard-v2/src/routes/MapPage.vue`
- `cmms-api/dashboard-v2/src/routes/DiffPage.vue`
- `cmms-api/dashboard-v2/src/routes/TokensPage.vue`
- `cmms-api/dashboard-v2/src/components/Button.vue`
- `cmms-api/dashboard-v2/src/components/Input.vue`
- `cmms-api/dashboard-v2/src/components/SegmentedControl.vue`
- `cmms-api/dashboard-v2/src/components/Badge.vue`
- `cmms-api/dashboard-v2/src/components/EmptyState.vue`
- `cmms-api/dashboard-v2/src/components/ErrorState.vue`
- `cmms-api/dashboard-v2/src/components/Skeleton.vue`
- `cmms-api/dashboard-v2/src/components/Toast.vue`
- `cmms-api/dashboard-v2/src/components/Modal.vue`
- `cmms-api/dashboard-v2/src/components/Drawer.vue`
- `cmms-api/dashboard-v2/src/components/DiffBlock.vue`
- `cmms-api/dashboard-v2/src/composables/useApi.ts`
- `cmms-api/dashboard-v2/src/composables/useApiWithRetry.ts`
- `cmms-api/dashboard-v2/src/composables/useEventSource.ts`
- `cmms-api/dashboard-v2/src/composables/useStreamEvents.ts`
- `cmms-api/dashboard-v2/src/composables/useKeyboardShortcuts.ts`
- `cmms-api/dashboard-v2/src/composables/useSeedQ.ts`
- `cmms-api/dashboard-v2/src/stores/stream.ts`
- `cmms-api/dashboard-v2/src/stores/ask.ts`
- `cmms-api/dashboard-v2/src/lib/api.ts`
- `cmms-api/dashboard-v2/src/lib/renderAnswer.ts`
- `cmms-api/dashboard-v2/src/lib/cytoscape.ts`
- `cmms-api/dashboard-v2/src/lib/diff.ts`
- `cmms-api/dashboard-v2/tests/build.test.ts`
- `cmms-api/dashboard-v2/tests/atoms.test.ts`
- `cmms-api/dashboard-v2/tests/data-layer.test.ts`
- `cmms-api/dashboard-v2/tests/ask.test.ts`
- `cmms-api/dashboard-v2/tests/stream.test.ts`
- `cmms-api/dashboard-v2/tests/map.test.ts`
- `cmms-api/dashboard-v2/tests/diff.test.ts`
- `cmms-api/dashboard-v2/tests/tokens.test.ts`

**Created (cmms-api):**
- `cmms-api/deploy-dashboard-v2.ts`

**Modified:**
- `cmms-api/dashboard/server.ts` — new dashboard routing, `serveDashboardIndex()` helper, flipped `include_evidence: true` on `/api/map` proxy.
- `cmms-api/deploy-mcp.ts` — chain in the new dashboard deploy step.

**Deleted:**
- `cmms-api/dashboard/ask/index.html`
- `cmms-api/dashboard/ask/manifest.json`
- `cmms-api/dashboard/ask/sw.js`
- `cmms-api/dashboard/dashboard.html`

**Modified (docs):**
- `AGENTS.md` — add `dashboard-v2` to the deployment table; reference the new deploy script.
- `docs/superpowers/specs/2026-08-12--cmms-dashboard-v2-redesign.md` — add a "Status: implemented" line at the top.

---

## Appendix B — Risks + open questions

1. **Backend agent's work not landed by Phase 1.1** — the entire plan blocks. Mitigation: ping the agent at the start; if they're still working, this plan can be staged (Phase 1.2-1.5 don't touch `server.ts`; only Phase 6 does).
2. **`include_evidence: true` payload size** — sample tickets add ~500 bytes per group. With `limit: 20` groups, that's ~10KB per `/api/map` response. Acceptable. If it's not, drop to `limit: 10` or `samples: 1`.
3. **Cytoscape on Linux ARM (zrok)** — Cytoscape is pure JS, no native deps. Should be fine.
4. **Vite base path + zrok** — zrok is a path-preserving proxy, so `/dashboard/...` paths work as-is. The Vite `base: '/dashboard/'` setting handles relative asset paths. Confirmed in spec §8 NIT-6.
5. **Audit log unbounded growth** — flagged as follow-up #5. Not in scope for v1.
6. **Inter Variable font file size** — the variable font is ~300KB. With Brotli on the zrok share, ~80KB. Acceptable for a tool the operator uses all day.
7. **PWA dropping** — operator loses the "Add to Home Screen" option. If they use that on a tablet, flag it back to them.
