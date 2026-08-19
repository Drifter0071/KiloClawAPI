<script setup lang="ts">
// src/routes/AdminPanelPage.vue
//
// The admin operations panel. Renders at /admin and:
//   1. Probes /api/admin/state on mount. If 401 (no admin cookie),
//      routes to /admin/login.
//   2. Shows two controls:
//        a) Maintenance lock — toggle that posts to
//           /api/admin/maintenance. When ON, all user API calls
//           503 and the user login form is disabled (with a
//           "Karbantartás alatt" notice and the mascot in builder-
//           hat mode).
//        b) Active sessions counter — refreshed on demand and
//           after every lock toggle, so the admin sees how many
//           users are currently signed in.
//   3. Auto-logs out after 3 minutes of inactivity. A 3-minute
//      inactivity timer resets on every mouse move, keypress, and
//      admin API response. When it fires, we POST to
//      /dashboard/admin/logout and route to /admin/login.
//   4. Logs out on page refresh. The admin cookie is the only
//      auth — no sessionStorage token to restore — so a refresh
//      starts with no admin session, the probe 401s, and we land
//      on /admin/login. (This is the spec: "should not get locked
//      even when maintenance lock is active" — meaning the admin
//      can always log in. Combined with the 3-minute TTL it also
//      means "refresh = logout" naturally.)
//   5. Exposes a manual "Kijelentkezés" button for explicit logout.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { humanizeError } from '@/lib/errors'
import Button from '@/components/Button.vue'
import { useAdminFeedback } from '@/composables/useAdminFeedback'

const router = useRouter()

// Hard inactivity timeout: 3 minutes. Matches the cookie TTL
// server-side (DASHBOARD_COOKIE_MAX_AGE in dashboard/server.ts).
const ADMIN_IDLE_MS = 3 * 60 * 1000
// Activity debounce: only treat the user as "active" once per
// 1.5s. mousemove fires on every pixel of cursor movement, and
// without a debounce the lastActivityAt timestamp would update
// 100+ times per second — which makes the displayed countdown
// (a computed of `now - lastActivityAt`) bounce between 2:59
// and 3:00 and never appear to count down. Throttling to one
// bump per 1.5s keeps the timer visually stable while still
// catching all meaningful user input.
const ACTIVITY_DEBOUNCE_MS = 1500

// --- State ---

const ready = ref(false)          // true after the initial probe resolves
const probeError = ref<string | null>(null)

const maintenance = ref(false)
const maintenanceSince = ref<string | null>(null)
const activeSessions = ref(0)
const totalSessions = ref(0)

const busy = ref(false)
const lastError = ref<string | null>(null)

// --- Feedback counters + verbose toggle -----------------------------------
//
// The admin panel surfaces a one-glance view of how the Ask
// like/dislike feature is going. Counters are all-time totals; the
// verbose toggle controls whether 👎 on the user side opens the
// reason modal. Both are fetched on mount alongside the maintenance
// probe, and refreshed on demand (and after every lock toggle, the
// same way the active-sessions counter does).
const adminFeedback = useAdminFeedback()
const likes = ref(0)
const dislikes = ref(0)
const verboseDislike = ref(false)
const feedbackBusy = ref(false)
const feedbackError = ref<string | null>(null)

async function fetchFeedback(): Promise<void> {
  feedbackBusy.value = true
  feedbackError.value = null
  try {
    // Counters are public; settings are admin. We fire both in
    // parallel — they're independent and both cheap.
    const [c, s] = await Promise.all([
      adminFeedback.loadFeedbackCounters(),
      adminFeedback.loadSettings(),
    ])
    likes.value = c.likes
    dislikes.value = c.dislikes
    verboseDislike.value = s.verbose_dislike
  } catch (e) {
    if (adminFeedback.isAdminAuthError(e)) {
      // 401 — the cookie is gone. Send the admin to /admin/login.
      await doLogout('no-session')
      return
    }
    feedbackError.value = humanizeError(e).description
  } finally {
    feedbackBusy.value = false
  }
}

async function toggleVerboseDislike(): Promise<void> {
  feedbackBusy.value = true
  feedbackError.value = null
  const next = !verboseDislike.value
  try {
    const r = await adminFeedback.saveSettings(next)
    verboseDislike.value = r.verbose_dislike
  } catch (e) {
    feedbackError.value = humanizeError(e).description
  } finally {
    feedbackBusy.value = false
  }
}

function openDislikedPage(): void {
  // The page uses the standard <router-link> pattern; the button
  // is here for keyboard / screen-reader convenience. We just route.
  router.push('/disliked')
}

const now = ref(Date.now())
const lastActivityAt = ref(Date.now())
const remainingMs = computed(() => Math.max(0, ADMIN_IDLE_MS - (now.value - lastActivityAt.value)))
const remainingLabel = computed(() => {
  const s = Math.ceil(remainingMs.value / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
})
const remainingPct = computed(() => Math.max(0, Math.min(100, (remainingMs.value / ADMIN_IDLE_MS) * 100)))

let tickTimer: number | null = null
let logoutTimer: number | null = null

function bumpActivity() {
  // Debounce: only advance lastActivityAt if the previous bump
  // was at least ACTIVITY_DEBOUNCE_MS ago. Without this, every
  // mousemove pixel sets lastActivityAt, which feeds into the
  // displayed countdown and makes it bounce between 2:59 and
  // 3:00 (the timer never visibly counts down). Throttling the
  // bump to once per 1.5s keeps the timer visually stable while
  // still resetting the auto-logout timeout whenever the user
  // does anything new.
  const nowMs = Date.now()
  if (nowMs - lastActivityAt.value < ACTIVITY_DEBOUNCE_MS) return
  lastActivityAt.value = nowMs
  // Re-arm the logout timer so it fires 3 min from THIS bump,
  // not from the previous one. (armLogoutTimer cancels any
  // pending setTimeout first, so a debounced bump is a no-op
  // here too — but that's fine, the timer is still anchored
  // to the most recent "real" activity.)
  armLogoutTimer()
}

function armLogoutTimer() {
  if (logoutTimer != null) {
    clearTimeout(logoutTimer)
  }
  // The timer is anchored to the lastActivityAt timestamp, not to
  // "now" — so a freshly-arming timer fires 3 min from the user's
  // most recent interaction. The 1Hz tick in the display layer
  // shows the time remaining; if the user is constantly active,
  // the displayed countdown resets to 3:00 at most once every
  // 1.5s (the debounce in bumpActivity), which is fine.
  logoutTimer = window.setTimeout(() => {
    void doLogout('inactivity')
  }, Math.max(0, ADMIN_IDLE_MS - (Date.now() - lastActivityAt.value)))
}

async function doLogout(reason: 'inactivity' | 'manual' | 'no-session') {
  if (logoutTimer != null) {
    clearTimeout(logoutTimer)
    logoutTimer = null
  }
  if (tickTimer != null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  try {
    await fetch('/dashboard/admin/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
  } catch { /* ignore network errors on logout */ }
  // Bounce the admin to the login page. The reason is shown as a
  // short flash via the ?reason=… query string.
  await router.replace(`/login?reason=${reason}`)
}

async function fetchState() {
  try {
    const r = await fetch('/dashboard/api/admin/state', {
      credentials: 'same-origin',
    })
    if (r.status === 401) {
      await doLogout('no-session')
      return
    }
    if (!r.ok) {
      probeError.value = `Szerver hiba: ${r.status}`
      return
    }
    const body = await r.json() as {
      ok: true
      maintenance: { enabled: boolean; since: string | null }
      active_sessions: number
      total_sessions: number
    }
    maintenance.value = body.maintenance.enabled
    maintenanceSince.value = body.maintenance.since
    activeSessions.value = body.active_sessions
    totalSessions.value = body.total_sessions
    ready.value = true
  } catch (e) {
    probeError.value = humanizeError(e).description
  }
}

async function toggleLock() {
  if (busy.value) return
  busy.value = true
  lastError.value = null
  bumpActivity()
  try {
    const r = await fetch('/dashboard/api/admin/maintenance', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !maintenance.value }),
    })
    if (r.status === 401) {
      await doLogout('no-session')
      return
    }
    if (!r.ok) {
      lastError.value = `Nem sikerült (${r.status})`
      return
    }
    const body = await r.json() as {
      ok: true
      maintenance: { enabled: boolean; since: string | null }
    }
    maintenance.value = body.maintenance.enabled
    maintenanceSince.value = body.maintenance.since
    // Refresh session counters (the lock wiped every session when
    // it flipped on, so the count drops to 0 immediately).
    await fetchState()
  } catch (e) {
    lastError.value = humanizeError(e).description
  } finally {
    busy.value = false
  }
}

function formatSince(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString('hu-HU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso
  }
}

onMounted(async () => {
  await fetchState()
  if (ready.value) {
    await fetchFeedback()
    bumpActivity()
    armLogoutTimer()
    // 1Hz countdown tick.
    tickTimer = window.setInterval(() => {
      now.value = Date.now()
    }, 1000)
    // Reset the activity timer on any user interaction. We do this
    // with passive listeners so it doesn't slow scrolling.
    const opts = { passive: true } as AddEventListenerOptions
    window.addEventListener('mousemove', bumpActivity, opts)
    window.addEventListener('keydown', bumpActivity, opts)
    window.addEventListener('click', bumpActivity, opts)
    window.addEventListener('touchstart', bumpActivity, opts)
  }
})

onBeforeUnmount(() => {
  if (tickTimer != null) clearInterval(tickTimer)
  if (logoutTimer != null) clearTimeout(logoutTimer)
})
</script>

<template>
  <div
    class="nct-theme-transition min-h-[100dvh] w-full
           bg-[var(--color-canvas)] text-[var(--nct-form-text)] font-sans antialiased
           px-4 sm:px-6 py-6 sm:py-10"
    data-testid="admin-panel-page"
  >
    <div class="max-w-3xl mx-auto space-y-6">
      <!-- Header -->
      <header class="flex items-start justify-between gap-4">
        <div>
          <div class="inline-flex items-center gap-2 mb-3">
            <span
              class="inline-flex items-center gap-1.5 h-6 px-2 rounded-full
                     border border-amber-500/30 bg-amber-500/10
                     text-[10.5px] font-mono tracking-wider uppercase
                     text-amber-600 dark:text-amber-300"
            >
              <span class="w-1 h-1 rounded-full bg-amber-500" />
              operations
            </span>
          </div>
          <h1
            class="text-[1.6rem] sm:text-[1.85rem] font-semibold tracking-tight m-0"
            data-testid="admin-panel-title"
          >
            NCT Operations
          </h1>
          <p class="mt-1 text-[14px] text-[var(--nct-form-text-muted)] m-0">
            Karbantartási zár és munkamenetek felügyelete.
          </p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <div
            v-if="ready"
            class="text-right"
            data-testid="admin-idle-timer"
            :title="`${Math.ceil(remainingMs / 1000)} másodperc van hátra`"
          >
            <div class="text-[10.5px] font-mono tracking-wider uppercase text-[var(--nct-form-text-muted)]">
              auto-logout
            </div>
            <div class="text-[15px] font-mono tabular-nums" :class="remainingMs < 30_000 ? 'text-danger' : 'text-[var(--nct-form-text)]'">
              {{ remainingLabel }}
            </div>
            <div class="mt-1 h-1 w-24 rounded-full bg-[var(--nct-form-border)] overflow-hidden">
              <div
                class="h-full transition-[width] duration-200"
                :class="remainingMs < 30_000 ? 'bg-danger' : 'bg-amber-500'"
                :style="{ width: `${remainingPct}%` }"
              />
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="admin-logout-button"
            @click="doLogout('manual')"
          >
            Kijelentkezés
          </Button>
        </div>
      </header>

      <!-- Loading / probe error -->
      <div
        v-if="!ready && !probeError"
        class="rounded-2xl border border-[var(--nct-form-border)]
               bg-[var(--nct-form-bg)] p-8 text-center"
        data-testid="admin-panel-loading"
      >
        <div class="text-[14px] text-[var(--nct-form-text-muted)]">Betöltés…</div>
      </div>
      <div
        v-else-if="probeError"
        class="rounded-2xl border border-danger/30 bg-danger/10 p-6 text-danger text-[14px]"
        data-testid="admin-panel-probe-error"
      >
        {{ probeError }}
      </div>

      <template v-else>
        <!-- Maintenance lock card -->
        <section
          class="rounded-2xl border bg-[var(--nct-form-bg)]
                 p-6 sm:p-7"
          :class="maintenance
                   ? 'border-amber-500/60 shadow-[0_8px_32px_-12px_rgba(245,158,11,0.4)]'
                   : 'border-[var(--nct-form-border)]'"
          data-testid="admin-maintenance-card"
        >
          <div class="flex items-start gap-4">
            <div
              class="shrink-0 h-12 w-12 rounded-xl grid place-items-center
                     border"
              :class="maintenance
                       ? 'border-amber-500/60 bg-amber-500/15 text-amber-600 dark:text-amber-300'
                       : 'border-[var(--nct-form-border)] bg-[var(--nct-surface)] text-[var(--nct-form-text-muted)]'"
            >
              <!-- Padlock icon -->
              <svg
                v-if="!maintenance"
                width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              <svg
                v-else
                width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 7-2.7" />
                <line x1="4" y1="4" x2="20" y2="20" />
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <h2 class="text-[17px] font-semibold m-0">
                Karbantartási zár
              </h2>
              <p class="mt-1 text-[13.5px] text-[var(--nct-form-text-muted)] m-0">
                <template v-if="maintenance">
                  <strong class="text-amber-600 dark:text-amber-300">Aktív</strong>
                  — minden felhasználó ki van jelentkeztetve, a bejelentkezési
                  űrlap le van zárva, a kabala építősapkát visel. Az
                  üzemeltetői panel továbbra is elérhető.
                  <span v-if="maintenanceSince" class="block mt-1 font-mono text-[12px]">
                    Bekapcsolva: {{ formatSince(maintenanceSince) }}
                  </span>
                </template>
                <template v-else>
                    Kikapcsolva — a felhasználók be tudnak jelentkezni és
                    használni tudják a dashboardot. Bekapcsoláskor minden
                    aktív munkamenet azonnal lejár.
                </template>
              </p>
            </div>
            <Button
              variant="primary"
              size="md"
              :loading="busy"
              :class="maintenance
                       ? '!bg-amber-600 hover:!bg-amber-700 !text-white shadow-[0_8px_24px_-12px_rgba(245,158,11,0.55)]'
                       : '!bg-amber-500 hover:!bg-amber-600 !text-white shadow-[0_8px_24px_-12px_rgba(245,158,11,0.55)]'"
              data-testid="admin-maintenance-toggle"
              @click="toggleLock"
            >
              {{ maintenance ? 'Feloldás' : 'Karbantartás be' }}
            </Button>
          </div>
          <div
            v-if="lastError"
            class="mt-4 px-3 py-2 rounded-lg border border-danger/30 bg-danger/10
                   text-danger text-[13px]"
            data-testid="admin-maintenance-error"
            role="alert"
          >
            {{ lastError }}
          </div>
        </section>

        <!-- Active sessions card -->
        <section
          class="rounded-2xl border border-[var(--nct-form-border)]
                 bg-[var(--nct-form-bg)] p-6 sm:p-7"
          data-testid="admin-sessions-card"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="text-[17px] font-semibold m-0">Aktív munkamenetek</h2>
              <p class="mt-1 text-[13.5px] text-[var(--nct-form-text-muted)] m-0">
                Az elmúlt 10 percben tevékeny felhasználói munkamenetek száma
                a kiszolgálón.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              data-testid="admin-sessions-refresh"
              :loading="busy"
              @click="fetchState"
            >
              Frissítés
            </Button>
          </div>
          <div class="mt-5 grid grid-cols-2 gap-4">
            <div
              class="rounded-xl border border-[var(--nct-form-border)]
                     bg-[var(--nct-surface)] p-5"
              data-testid="admin-sessions-active"
            >
              <div class="text-[11px] font-mono tracking-wider uppercase text-[var(--nct-form-text-muted)]">
                Aktív (10 perc)
              </div>
              <div class="mt-1 text-[2rem] font-semibold leading-none tabular-nums">
                {{ activeSessions }}
              </div>
            </div>
            <div
              class="rounded-xl border border-[var(--nct-form-border)]
                     bg-[var(--nct-surface)] p-5"
              data-testid="admin-sessions-total"
            >
              <div class="text-[11px] font-mono tracking-wider uppercase text-[var(--nct-form-text-muted)]">
                Összes tárolt
              </div>
              <div class="mt-1 text-[2rem] font-semibold leading-none tabular-nums">
                {{ totalSessions }}
              </div>
            </div>
          </div>
        </section>

        <!-- Ask feedback card (counters + verbose toggle) -->
        <section
          class="rounded-2xl border border-[var(--nct-form-border)]
                 bg-[var(--nct-form-bg)] p-6 sm:p-7"
          data-testid="admin-feedback-card"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="text-[17px] font-semibold m-0">Ask visszajelzések</h2>
              <p class="mt-1 text-[13.5px] text-[var(--nct-form-text-muted)] m-0">
                A felhasználók like / dislike szavazatai az Ask felületen.
                A „Részletes dislike" bekapcsolásával a 👎 kattintás után
                egy 5+1 opciós modal nyílik.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              data-testid="admin-feedback-refresh"
              :loading="feedbackBusy"
              @click="fetchFeedback"
            >
              Frissítés
            </Button>
          </div>
          <div class="mt-5 grid grid-cols-2 gap-4">
            <div
              class="rounded-xl border border-[var(--nct-form-border)]
                     bg-[var(--nct-surface)] p-5"
              data-testid="admin-feedback-likes"
            >
              <div class="text-[11px] font-mono tracking-wider uppercase text-[var(--nct-form-text-muted)]">
                👍 Tetszik
              </div>
              <div class="mt-1 text-[2rem] font-semibold leading-none tabular-nums">
                {{ likes }}
              </div>
            </div>
            <div
              class="rounded-xl border border-[var(--nct-form-border)]
                     bg-[var(--nct-surface)] p-5"
              data-testid="admin-feedback-dislikes"
            >
              <div class="text-[11px] font-mono tracking-wider uppercase text-[var(--nct-form-text-muted)]">
                👎 Nem tetszik
              </div>
              <div class="mt-1 text-[2rem] font-semibold leading-none tabular-nums">
                {{ dislikes }}
              </div>
            </div>
          </div>
          <div class="mt-4 flex items-center justify-between gap-3
                      rounded-xl border border-[var(--nct-form-border)]
                      bg-[var(--nct-surface)] p-4">
            <div class="min-w-0">
              <div class="text-[14px] font-medium text-[var(--nct-form-text)]">
                Részletes dislike
              </div>
              <div class="text-[12px] text-[var(--nct-form-text-muted)] mt-0.5">
                Ha aktív, a 👎 kattintás egy 5 opciós + „Egyéb" modalt nyit.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="verboseDislike"
              :disabled="feedbackBusy"
              class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full
                     transition-colors duration-150
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
                     disabled:opacity-50 disabled:cursor-not-allowed"
              :class="verboseDislike ? 'bg-[var(--nct-accent,#3d275c)]' : 'bg-[var(--nct-form-border)]'"
              data-testid="admin-feedback-verbose-toggle"
              @click="toggleVerboseDislike"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white shadow
                       transition-transform duration-150"
                :class="verboseDislike ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>
          <button
            type="button"
            class="mt-3 w-full text-left
                   rounded-xl border border-[var(--nct-form-border)]
                   bg-[var(--nct-surface)] hover:bg-[var(--nct-form-bg)]
                   px-4 py-3
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
            data-testid="admin-feedback-open-disliked"
            @click="openDislikedPage"
          >
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-[14px] font-medium text-[var(--nct-form-text)]">
                  Disliked válaszok listája
                </div>
                <div class="text-[12px] text-[var(--nct-form-text-muted)] mt-0.5">
                  Minden 👎 szavazat, időrendben, a teljes ügynök-válasz snapshot-tal.
                </div>
              </div>
              <span class="text-[18px] text-[var(--nct-form-text-muted)]" aria-hidden="true">→</span>
            </div>
          </button>
          <div
            v-if="feedbackError"
            class="mt-3 px-3 py-2 rounded-lg border border-danger/30 bg-danger/10
                   text-danger text-[13px]"
            data-testid="admin-feedback-error"
            role="alert"
          >
            {{ feedbackError }}
          </div>
        </section>

        <!-- Help card -->
        <section
          class="rounded-2xl border border-[var(--nct-form-border)]
                 bg-[var(--nct-form-bg)] p-5 sm:p-6 text-[13px]
                 text-[var(--nct-form-text-muted)] leading-[1.55]"
        >
          <strong class="text-[var(--nct-form-text)]">Tippek.</strong>
          A karbantartási zár bekapcsolásakor a szerver azonnal eldobja
          minden felhasználó session-azonosítóját, így a megnyitott
          füleken is lejár a dashboard — a felhasználó a „Karbantartás
          alatt" feliratot fogja látni a bejelentkezési oldalon. Ez a
          panel 3 perc inaktivitás után automatikusan kijelentkezik,
          illetve az oldal frissítésekor is.
        </section>
      </template>
    </div>
  </div>
</template>
