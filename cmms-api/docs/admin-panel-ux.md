# Admin Panel UX Design

**Status:** Phase 8 redesign + build. Live on `https://nctmechanic.shares.zrok.io/dashboard/v2/admin`.
**Audience:** NCT internal operator (Gergely), running the operations side of the dashboard.
**Surface:** `/admin`, `/admin/login`, `/admin/disliked` — three routes, all under the v2 SPA.

---

## 1. The big idea: "two apps, one shell"

The admin panel is **deliberately not a tab in the operator dashboard**. It's a
separate surface with:

- A **separate login** (amber `operations` chip, not purple `belső rendszer`).
- A **separate cookie** (`cmms_dash_admin_sid` with a 3-minute TTL, vs. the
  8-hour operator cookie `cmms_dash_sid`).
- A **separate URL prefix** (`/admin/*`, never reachable from operator nav
  clicks — the operator always gets the operator's surface).
- A **separate visual accent** (amber `#F59E0B` for operations, purple
  `#7C5CE5` for operator work). The two accents are never mixed in one card.
- A **separate auth gate** on the cmms-api side (the write-token + admin
  cookie both required; the operator cookie alone does not unlock admin
  endpoints — see `dashboard/server.ts:checkAdminCookie`).

The reason for the split: when the operator dashboard is in **maintenance
lock**, every operator session is killed. The admin has to be able to come
back and unlock it. A shared cookie would lock the admin out, too.

---

## 2. Route map

```
/admin/login                 AdminLoginPage        (public — no cookie)
/admin                       AdminPanelPage        (admin cookie required)
/admin/disliked              DislikedAnswersPage   (admin cookie required)
```

The operator-facing pages (`/ask`, `/stream`, `/map`, `/diff`, `/tokens`)
have **no awareness** of `/admin/*`. If a user is logged in as an operator
only, navigating to `/admin` bounces to `/admin/login` (which then 401s the
admin probe and shows the form).

---

## 3. The AdminLoginPage (the entry point)

### 3.1 What it looks like

A near-mirror of `LoginPage.vue` (the operator login), with three deliberate
differences:

| Element         | Operator login             | Admin login                |
|-----------------|----------------------------|----------------------------|
| Brand chip      | purple `belső rendszer`    | **amber `operations`**     |
| Heading         | "Bejelentkezés"            | **"Admin bejelentkezés"**  |
| Submit button   | purple (`nct-500`)         | **amber** (`#F59E0B`)      |
| Ambient glow    | purple radial gradients    | **amber** radial gradients |
| Endpoint        | `/dashboard/login`         | **`/dashboard/admin/login`** |
| Cookie set      | `cmms_dash_sid` (8h)       | **`cmms_dash_admin_sid` (3m)** |
| Mascot scene    | full animation             | full animation (same NctMascotScene) |

The mascot scene is the same — both logins share the playful brand, but the
color context around it makes them feel like two different rooms in the same
building, not the same room with a different sign.

### 3.2 The flow

1. User clicks "Admin" in the topbar (or the operator menu's "Admin panel"
   item) → routed to `/admin/login`.
2. The page's `onMounted` probes `/dashboard/api/admin/state` with
   `credentials: 'same-origin'`. If the admin cookie is still valid (within
   the 3-minute window), the probe returns 200 and the user is auto-routed
   to `/admin`. No form shown.
3. Otherwise the form renders. User types the admin password, hits Enter
   (or clicks the amber button).
4. POST to `/dashboard/admin/login` with `{ password }`. On 200 the server
   sets the admin cookie and the client runs the state probe again to
   confirm. On 401, "Hibás jelszó." is shown inline in the danger-coloured
   alert box.
5. On success, the SPA pushes to `/admin` (the panel). The cookie is now
   in the browser; subsequent admin API calls include it.

### 3.3 The reason banner (the bounce-back UX)

When the user is bounced to `/admin/login` from somewhere else (the panel
auto-logged them out for inactivity, or they hit Kijelentkezés), the page
shows a small amber status banner above the card explaining why. The
`?reason=` query string is set by `AdminPanelPage.doLogout()`.

| `?reason=` value | Banner text                                              |
|------------------|----------------------------------------------------------|
| `inactivity`     | "Az üzemeltetői munkamenet inaktivitás miatt lejárt."    |
| `no-session`     | "Az üzemeltetői munkamenet már nem érvényes."            |
| `manual`         | "Kijelentkeztél az üzemeltetői munkaterületről."         |

This way the user is never confused about *why* they're seeing a login
screen when they were just on the panel.

### 3.4 Test selectors (kept for stability)

- `data-testid="admin-login-page"` / `admin-login-card` /
  `admin-login-password` / `admin-login-submit` / `admin-login-error` /
  `admin-login-reason`

---

## 4. The AdminPanelPage (the main work surface)

This is what the operator sees after a successful admin login. It is a
**single column, max-width 3xl (768px) page**, NOT a tab inside the
operator dashboard. There is no sidebar, no top app nav, no operator
theme — just the page.

### 4.1 Layout

```
┌──────────────────────────────────────────────────────┐
│  [operations] chip                                    │
│  NCT Operations                                      │
│  Karbantartási zár és munkamenetek felügyelete.       │
│                                       [auto-logout]  │
│                                       [3:00 countdown]│
│                                       [Kijelentkezés]│
├──────────────────────────────────────────────────────┤
│  🔒 Karbantartási zár card                            │
│   - amber-tinted when ON                              │
│   - shows "Bekapcsolva: HH:MM:SS" timestamp when ON   │
│   - [Karbantartás be] / [Feloldás] button (amber)     │
├──────────────────────────────────────────────────────┤
│  👥 Aktív munkamenetek card                           │
│   - two stat boxes: "Aktív (10 perc)" and "Összes"    │
│   - [Frissítés] button                                │
├──────────────────────────────────────────────────────┤
│  👍👎 Ask visszajelzések card                         │
│   - like / dislike counters                           │
│   - "Részletes dislike" toggle (settings)             │
│   - [Disliked válaszok listája] button → /admin/disliked │
├──────────────────────────────────────────────────────┤
│  💡 Tippek card (grey, small)                         │
└──────────────────────────────────────────────────────┘
```

### 4.2 Header (sticky-style, top right)

The header has three things on the right:

1. **Auto-logout countdown** — shows remaining time as `M:SS` (e.g. "2:47"),
   with a thin progress bar below it. Below 30 seconds the timer turns
   red. The bar is amber normally, red below 30s.
2. **Kijelentkezés button** — small, secondary. Always visible.
3. **No theme toggle** — admin uses the same theme as the operator, so
   the operator's preference carries over. (We could add a toggle later;
   right now it's intentionally absent to keep the surface focused.)

The countdown resets on every mouse move, keypress, click, and touch —
debounced to 1.5s so the displayed number doesn't bounce 100×/sec from
mousemove pixels. When the countdown hits 0, the page auto-logs-out
(see §4.6).

### 4.3 The maintenance lock card

The most-used control. Two states:

**OFF (default)** — gray padlock icon, calm text:
> "Kikapcsolva — a felhasználók be tudnak jelentkezni és használni tudják
> a dashboardot. Bekapcsoláskor minden aktív munkamenet azonnal lejár."

Button: **"Karbantartás be"** (amber, prominent).

**ON** — amber padlock with strike-through, amber-tinted card border with
soft amber glow, text:
> "**Aktív** — minden felhasználó ki van jelentkeztetve, a bejelentkezési
> űrlap le van zárva, a kabala építősapkát visel. Az üzemeltetői panel
> továbbra is elérhető."
>
> "Bekapcsolva: HH:MM:SS" (the ISO timestamp of when the lock went on).

Button: **"Feloldás"** (amber).

Toggling fires POST `/dashboard/api/admin/maintenance` with
`{ enabled: <bool> }`. On 200, the card animates between states. On any
error, a red alert strip appears below the button with the humanized
error message.

#### 4.3.1 What "minden aktív munkamenet azonnal lejár" actually means

When the toggle goes ON, the server sets `MAINTENANCE.enabled = true`. On
the next request from any operator, the handler returns:
```json
HTTP/1.1 503 Service Unavailable
{ "error": "maintenance", "maintenance": true, "message": "Karbantartás alatt" }
```

The LoginPage already probes `/dashboard/api/tokens` on mount; the 503
(or 401, depending on the order of checks) routes the user to the
"Karbantartás alatt" screen with the mascot in builder-hat mode.

The admin's own session is unaffected — `checkAdminCookie()` is checked
*before* the maintenance gate, so the admin can always flip the lock off
again. This is the design: the admin never gets locked out of their own
panel by their own lock.

### 4.4 The active sessions card

Two stat boxes side by side:
- **Aktív (10 perc)**: number of unique operator cookie SIDs seen in
  the last 10 minutes.
- **Összes tárolt**: cumulative count of unique SIDs ever seen (since
  process start).

The "Aktív" count prunes stale entries on every read. The "Összes" is a
monotonically increasing counter (the in-memory map's `totalSessionsEver`
field). Both reset on process restart.

A "Frissítés" button re-fetches. Toggling the lock also re-fetches (the
lock typically drops the active count to 0).

### 4.5 The Ask feedback card

Three sub-sections, all on one card:

1. **Like / dislike counters** — two stat boxes showing the all-time
   totals from `feedback_votes`.
2. **Részletes dislike toggle** — when ON, the user-side 👎 click opens
   the 5-option + "Egyéb" reason modal. When OFF, the modal is skipped
   and the dislike is recorded without a reason. The toggle is a
   switch-style button, purple when ON (to match the `nct-soft` accent
   that the Ask UI itself uses for active controls), gray when OFF.
3. **"Disliked válaszok listája" button** — full-width secondary button
   that navigates to `/admin/disliked`. It's a `<router-link>` rendered
   as a button for keyboard/screen-reader convenience.

A "Frissítés" button at the top-right of the card re-fetches both the
counters and the settings.

Errors are shown in a red strip below the card. If the error is a 401
(admin cookie expired), the page auto-logs-out and routes to
`/admin/login?reason=no-session`.

### 4.6 Auto-logout (the 3-minute idle timer)

**3 minutes of no activity** = auto-logout. Implemented in
`AdminPanelPage.vue`:

- `ADMIN_IDLE_MS = 3 * 60 * 1000` (matches the cookie TTL server-side).
- Activity listeners: `mousemove`, `keydown`, `click`, `touchstart` — all
  passive (don't slow scrolling).
- `bumpActivity()` debounces to 1.5s so a moving mouse doesn't update
  the displayed countdown 100×/sec.
- A 1Hz `setInterval` updates the displayed `now` ref → `remainingMs`
  recomputes → countdown ticks visibly.
- When the timer fires: `doLogout('inactivity')` → POST
  `/dashboard/admin/logout` (clears the cookie) → `router.replace('/admin/login?reason=inactivity')`.

**Refresh = logout**: the admin cookie is the only auth; there's no
sessionStorage token to restore. On a hard refresh, the AdminLoginPage's
`onMounted` probe 401s, and the form renders. (Combined with the 3-min
TTL this means "walk away from the desk for 4 minutes" = automatic
logout = the operator user can't leave a long-lived admin session
hanging.)

### 4.7 The "Tippek" card (the help reminder)

A small grey card at the bottom. One paragraph reminding the operator
what the lock does, the idle timer, and the refresh behavior. It's not
docs — it's an in-product reminder that lives in the surface the admin
is actually looking at.

---

## 5. The DislikedAnswersPage (the drill-down)

Reached from the panel's "Disliked válaszok listája" button.

### 5.1 Layout

A master/detail view:

```
┌──────────────────────────┬──────────────────────────┐
│  List of disliked        │  Drawer (slides in from  │
│  answers, one per row:   │  the right on mobile,     │
│  - question              │  or fixed right column    │
│  - timestamp             │  on desktop):             │
│  - customer (if any)     │  - full final_text        │
│  - reason                │  - tool trace (collapsible)│
│                          │  - ticket cards           │
│  [load more] at bottom   │  - the user's proposed    │
│                          │    correction (if any),   │
│                          │    in a green-bordered    │
│                          │    card with "javítva"    │
│                          │    badge                  │
└──────────────────────────┴──────────────────────────┘
```

### 5.2 The list rows

Each row is a small horizontal card:
- The question (1-2 lines, truncated)
- The customer (if resolved) or "—"
- The timestamp (relative, like "2 órája" — using `formatHuDateTime` from
  `lib/diff.ts` for absolute)
- The reason badge (one of the 5 fixed reasons, or `other:` + preview)
- A `→` chevron at the right

Clicking a row sets `selectedIndex` and opens the drawer. The list keeps
its scroll position (the drawer is teleported, so it doesn't push the
list around).

### 5.3 The drawer

On mobile (default), the drawer slides in from the right and takes the
full width. On desktop (≥ md), it's a fixed right column of ~480px and
the list shrinks to fill the remaining width.

The drawer shows, top to bottom:
1. The question (heading).
2. The customer + device + sorszam (if any), as small chips.
3. The full `final_text` of the assistant's response.
4. A collapsible "Eszközhívások" section listing the tool calls
   (name, args preview, result preview).
5. A "Javasolt helyes válasz" card with a green border — only renders
   if the user who disliked it submitted a correction. The card shows
   the correction text and a "javítva" badge in the corner. This is
   the whole point of the "share correct answer" feature: the admin
   sees what the user *thought the answer should have been*, so the
   admin can decide if the agent's prompt needs work.
6. A close button (`X`) at the top right.

A small "Bezárás" button at the bottom of the drawer also closes it.

### 5.4 Pagination

50 items per page. A "Továbbiak betöltése" button at the bottom of the
list calls `loadDisliked(limit, offset + 50)` and appends. The total
count is shown in the panel card on `/admin`, so the admin knows the
universe size without leaving the previous page.

---

## 6. The "disconnected" feeling — what enforces it

The user said "feels completely disconnected from the main app". Here's
what enforces that:

### 6.1 Color separation

Every operator page uses purple (`nct-500`, `nct-soft`, `--color-accent`).
Every admin page uses amber (`#F59E0B`, `amber-500`, `amber-600`). The
two never appear on the same card. The brand chip on the admin login
explicitly says "operations" in amber; the operator login says "belső
rendszer" in purple. There's no purple on the admin pages and no amber
on the operator pages.

### 6.2 No shared topbar / sidebar

The admin pages do NOT use `AppShell.vue`. They're rendered as
bare-page components — no ConversationRail, no AppTopbar, no
BottomTabs. The 3-minute countdown replaces the topbar's role of
telling the user where they are. The Kijelentkezés button replaces
the OperatorMenu's logout.

### 6.3 Different cookie TTL

The operator cookie lives for 8 hours. The admin cookie lives for 3
minutes. The two are signed with the same secret but stored under
different names. The server checks them independently:
- `checkCookie()` returns true for the operator.
- `checkAdminCookie()` returns true for the admin.
- Neither is a substitute for the other.

### 6.4 Different login endpoint

`/dashboard/login` (operator) vs. `/dashboard/admin/login` (admin).
Same password (the `DASHBOARD_PASSWORD` env var), but different cookies,
different audit log entries (`login` vs. `admin_login`).

### 6.5 Maintenance is a one-way signal

The admin can flip the maintenance lock ON (killing every operator
session). The operator cannot flip the maintenance lock at all. The
admin's actions never affect another admin's session. The operator's
actions never affect the admin surface.

### 6.6 Different URL prefix

Operator URLs: `/dashboard/v2/ask`, `/dashboard/v2/stream`, …
Admin URLs: `/dashboard/v2/admin`, `/dashboard/v2/admin/login`,
`/dashboard/v2/admin/disliked`.

The `/admin/*` namespace is exclusively for the operations surface.
The operator can navigate *to* `/admin` (from the topbar Admin link or
the operator menu's "Admin panel" item), but they're treated as a fresh
visitor — no admin session is implied by the operator session.

### 6.7 The audit log

Both flows push to the same `auditLog` array (in
`dashboard/server.ts:pushAudit`), but with different `action` strings:
- Operator: `login`, `login_failed`, `logout`, `question`, `answer`.
- Admin: `admin_login`, `admin_login_failed`, `admin_logout`,
  `maintenance_on`, `maintenance_off`.

A future read of the audit log can filter by `action === 'admin_*'`
to see the full admin history separately from operator history.

---

## 7. What the admin can and cannot do

### 7.1 Can

- Log in to `/admin/login` (same `DASHBOARD_PASSWORD` as the operator).
- View the maintenance lock state and toggle it.
- See the count of currently-active operator sessions (last 10 min)
  and the total ever seen.
- View the all-time like / dislike counters for the Ask feature.
- Toggle "Részletes dislike" — the verbose reason modal on 👎.
- View the list of all disliked Ask answers (in chronological order,
  with the full agent snapshot: question, answer, tool trace, model,
  language, customer, ticket cards).
- View each disliked answer's user-submitted correction (if any), in
  the green-bordered "Javasolt helyes válasz" card.
- Manually log out.
- Be auto-logged-out after 3 minutes of inactivity.

### 7.2 Cannot

- Modify individual tickets (no access to `create_ticket`,
  `modify_ticket`, `close_ticket`).
- Delete any data.
- Rotate tokens.
- Read other admin's audit history.
- Disable the maintenance lock from the operator side (the lock
  only kills operator sessions, not admin sessions).
- Stay logged in for more than 3 minutes of idle time.

### 7.3 Future

These are out of scope for the current build, but the surface is
designed to grow:
- A "Tokenek" tab on the admin panel that links to `/tokens`
  (already exists as an operator surface, but admins may want a
  different view of the token prefix etc.).
- An "Audit" tab on the admin panel showing the `auditLog` array
  filtered to `admin_*` actions.
- A "Karbantartás history" card showing the last N
  `maintenance_on` / `maintenance_off` transitions with timestamps.
- Per-answer "javítva" marking — the admin can flip a `corrected`
  flag on a feedback row once they've actually fixed the prompt that
  produced the bad answer.

These are listed here so future-me doesn't accidentally design
something that breaks the "two apps" feel.

---

## 8. Test surface

- `tests/24-dashboard-auth.test.ts` — the v2 SPA's auth gate. Currently
  covers the operator path; the admin path tests live in
  `tests/24b-admin-auth.test.ts` (TODO). At minimum:
  - `/dashboard/admin/login` with wrong password → 401 JSON.
  - `/dashboard/admin/login` with right password → 200 + admin cookie.
  - `/dashboard/api/admin/state` without admin cookie → 401.
  - `/dashboard/api/admin/state` with admin cookie → 200 JSON.
  - `/dashboard/api/admin/maintenance` POST flips the global flag
    and returns the new state.
  - The cmms-api side: `/v1/feedback/settings` with the write token
    works, with the read token returns 403.
- `tests/36-feedback.test.ts` — the user-side feedback endpoints
  (vote, my-votes, counters, correction, settings, disliked list).
  The admin path reuses the cmms-api write gate that this test
  suite already exercises.
- The admin UI is tested in `dashboard-v2/tests/` via
  `@playwright/test`. The selectors in §3.4 are the anchors.

---

## 9. Summary — one paragraph

The admin panel is a **second, smaller, shorter-lived app** that lives
under the same SPA shell. It has its own login, its own cookie, its own
visual accent (amber vs. purple), its own route namespace, and its own
auto-logout timer. The only thing it shares with the operator dashboard
is the password (so an operator who knows the operator password can
also be the admin) and the theme (light / dark). The maintenance lock
is the bridge between the two apps: the admin can flip it on to kill
every operator session, but flipping it never touches the admin's own
session. The "disconnected" feeling is the design, not a bug.
