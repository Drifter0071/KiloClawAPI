<script setup lang="ts">
// src/routes/AdminLoginPage.vue
//
// Admin login screen. Mirrors LoginPage.vue (the operator login) but
// posts to a separate endpoint (/dashboard/admin/login) that gates
// /admin/* and the feedback counters / verbose-dislike / disliked list
// features on a SEPARATE admin cookie. The operator cookie does not
// unlock admin endpoints — the spec is "admin should not get locked
// even when maintenance lock is active", which means the admin auth
// path is independent from the operator path.
//
// Selectors kept for the test suite:
//   data-testid="admin-login-page" / "admin-login-card" /
//                  "admin-login-password" / "admin-login-submit" /
//                  "admin-login-error" / "admin-login-reason"
// Required copy kept for the test suite:
//   "Admin bejelentkezés" heading
//   "Hibás jelszó." error string
//   "Karbantartás alatt" reason banner

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { humanizeError } from '@/lib/errors'
import { useTheme } from '@/composables/useTheme'
import Button from '@/components/Button.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

const router = useRouter()
const route = useRoute()
useTheme()

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const errorText = ref<string | null>(null)
const passwordInputRef = ref<HTMLInputElement | null>(null)

const submitDisabled = computed(
  () => submitting.value || password.value.length === 0,
)

// Reason banner (shown when the user was bounced here by an admin
// auto-logout). Query string is set by AdminPanelPage.doLogout().
const reason = computed<string | null>(() => {
  const r = route.query.reason
  if (typeof r !== 'string') return null
  if (r === 'inactivity') return 'Az üzemeltetői munkamenet inaktivitás miatt lejárt.'
  if (r === 'no-session') return 'Az üzemeltetői munkamenet már nem érvényes.'
  if (r === 'manual') return 'Kijelentkeztél az üzemeltetői munkaterületről.'
  return null
})

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

interface AdminLoginSuccess {
  ok: true
}
interface AdminLoginFailure {
  ok: false
  error?: string
}
type AdminLoginResponse = AdminLoginSuccess | AdminLoginFailure

async function submit() {
  if (submitDisabled.value) return
  submitting.value = true
  errorText.value = null

  try {
    const res = await fetch('/dashboard/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: password.value }),
    })

    let body: AdminLoginResponse | null = null
    try {
      body = (await res.json()) as AdminLoginResponse
    } catch {
      body = null
    }

    if (res.ok && body && body.ok) {
      // Probe the admin state to ensure the cookie is real. If the
      // probe 401s, fall back to the error path.
      const probe = await fetch('/dashboard/api/admin/state', {
        credentials: 'same-origin',
      })
      if (probe.ok) {
        await router.replace('/panel')
        return
      }
      errorText.value = 'Hibás jelszó.'
      return
    }

    errorText.value = 'Hibás jelszó.'
  } catch (err) {
    errorText.value = humanizeError(err).description
  } finally {
    submitting.value = false
    passwordInputRef.value?.focus()
  }
}

// ---------------------------------------------------------------------------
// UX niceties
// ---------------------------------------------------------------------------

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Enter' || evt.key === 'enter') {
    if (submitDisabled.value) return
    evt.preventDefault()
    void submit()
  }
}

function togglePasswordVisibility() {
  showPassword.value = !showPassword.value
}

/** If the admin is already authed, skip the login screen. The
 *  /dashboard/api/admin/state probe 401s on a stale cookie, and the
 *  probe returning 200 means the user can go straight to the panel. */
onMounted(() => {
  fetch('/dashboard/api/admin/state', { credentials: 'same-origin' })
    .then((r) => {
      if (r.ok) void router.replace('/panel')
    })
    .catch(() => { /* stay on the login page */ })
})
</script>

<template>
  <div
    class="nct-theme-transition relative min-h-[100dvh] w-full overflow-x-hidden
           bg-[var(--color-canvas)] text-[var(--nct-form-text)] font-sans antialiased
           flex flex-col"
    data-testid="admin-login-page"
  >
    <!-- ===================== Background field ===================== -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 -z-0 overflow-hidden"
    >
      <!-- Admin accent is amber (operations), not purple (operator). -->
      <div
        class="absolute -top-32 -left-32 w-[42rem] h-[42rem] rounded-full
               bg-[radial-gradient(closest-side,rgba(245,158,11,0.18),transparent_70%)]
               blur-3xl opacity-80 animate-nct-drift"
      />
      <div
        class="absolute -bottom-40 -right-24 w-[36rem] h-[36rem] rounded-full
               bg-[radial-gradient(closest-side,rgba(245,158,11,0.14),transparent_70%)]
               blur-3xl opacity-70 animate-nct-drift"
        style="animation-delay: -3s"
      />
      <div
        class="absolute inset-0 opacity-[0.06]
               bg-[linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)]
               bg-[size:48px_48px]"
      />
    </div>

    <!-- ===================== Theme toggle (top-right) ===================== -->
    <div
      class="relative z-10 flex justify-end w-full
             pt-[max(env(safe-area-inset-top),1.25rem)] pr-5 pb-3
             animate-nct-fade-in"
    >
      <ThemeToggle />
    </div>

    <!-- ===================== Main split layout ===================== -->
    <main
      class="relative z-10 flex-1 w-full grid
             grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]
             gap-y-10 md:gap-x-12 lg:gap-x-20
             px-5 sm:px-8 md:px-10 lg:px-14
             pb-[max(env(safe-area-inset-bottom),1.5rem)]
             pt-2 md:pt-6 lg:pt-10"
    >
      <!-- ============== Left visual / brand panel (md+) ============== -->
      <section
        class="hidden md:flex flex-col justify-center
               min-h-[calc(100dvh-7rem)] py-6
               animate-nct-fade-up"
        style="animation-delay: 60ms"
        aria-labelledby="admin-brand-heading"
      >
        <div>
          <h2
            id="admin-brand-heading"
            class="text-[clamp(1.75rem,2.6vw,2.5rem)] font-semibold leading-[1.1] tracking-tight
                   text-[var(--nct-form-text)]"
          >
            NCT Operations <span class="text-[var(--nct-form-text-muted)] font-normal">v2</span>
          </h2>
          <p class="mt-3 mb-6 max-w-[34ch] text-[15px] leading-[1.55] text-[var(--nct-form-text-muted)]">
            Karbantartási zár, aktív munkamenetek és az Ask
            visszajelzések (like / dislike) kezelése.
          </p>
        </div>

        <!-- Builder mascot (constructor helmet version) -->
        <div
          class="relative w-full max-w-[32rem] h-[220px] sm:h-[260px] md:h-[280px] my-3 pointer-events-none overflow-visible flex items-center justify-center"
          aria-hidden="true"
        >
          <div
            class="w-48 h-48 sm:w-56 sm:h-56 bg-[url('/dashboard/v2/mascot-builder.png')] bg-contain bg-no-repeat bg-center
                   drop-shadow-[0_8px_16px_rgba(61,39,92,0.45)] animate-nct-drift"
          />
        </div>

        <div class="flex items-center gap-3 text-[11px] font-mono tracking-wide text-[var(--nct-form-text-muted)]">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-nct-pulse-glow" />
          operations · NCT belső vezérlőpult
        </div>
      </section>

      <!-- ============== Right admin-login panel ============== -->
      <section
        class="flex flex-col justify-center
               min-h-[calc(100dvh-7rem)] md:py-6
               animate-nct-fade-up"
        style="animation-delay: 140ms"
        aria-labelledby="admin-login-heading"
      >
        <div
          v-if="reason"
          class="w-full max-w-[420px] mx-auto md:mx-0 md:ml-auto mb-3
                 flex items-start gap-2 px-3 py-2.5
                 rounded-lg border border-amber-500/40
                 bg-amber-500/10
                 text-amber-700 dark:text-amber-200
                 text-[13px] leading-[1.45] animate-nct-fade-in"
          data-testid="admin-login-reason"
          role="status"
        >
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
            stroke-linejoin="round" class="mt-0.5 shrink-0" aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="13" />
            <line x1="12.01" y1="16.5" x2="12" y2="16.5" />
          </svg>
          <span>{{ reason }}</span>
        </div>

        <div
          class="w-full max-w-[420px] mx-auto md:mx-0 md:ml-auto
                 rounded-2xl border border-amber-500/25
                 bg-[var(--nct-form-bg)]
                 shadow-[0_1px_0_var(--nct-line),0_24px_60px_-20px_rgba(245,158,11,0.25)]
                 backdrop-blur-md animate-nct-card-pulse
                 p-7 sm:p-8 md:p-9"
          data-testid="admin-login-card"
        >
          <div class="flex items-center gap-2 mb-5">
            <span
              class="inline-flex items-center gap-1.5 h-6 px-2 rounded-full
                     border border-amber-500/35
                     bg-amber-500/10
                     text-[10.5px] font-mono tracking-wider uppercase
                     text-amber-700 dark:text-amber-300"
            >
              <span class="w-1 h-1 rounded-full bg-amber-500" />
              operations
            </span>
          </div>

          <h1
            id="admin-login-heading"
            class="text-[1.6rem] md:text-[1.75rem] font-semibold tracking-tight text-[var(--nct-form-text)] m-0"
          >
            Admin bejelentkezés
          </h1>
          <p class="mt-1.5 text-[14px] leading-[1.5] text-[var(--nct-form-text-muted)] mb-6">
            Add meg az üzemeltetői jelszót a NCT Operations panel eléréséhez.
          </p>

          <form
            novalidate
            class="block"
            :aria-busy="submitting || undefined"
            @submit.prevent="submit"
          >
            <label
              for="admin-login-password"
              class="block text-[13px] font-medium text-[var(--nct-form-text)] mb-1.5"
            >
              Jelszó
            </label>
            <div class="relative">
              <input
                id="admin-login-password"
                ref="passwordInputRef"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                required
                autofocus
                :disabled="submitting"
                :aria-invalid="errorText ? 'true' : 'false'"
                aria-describedby="admin-login-error"
                placeholder="••••••••"
                class="w-full h-11 pl-3.5 pr-12 rounded-lg
                       bg-[var(--nct-surface)] border border-[var(--nct-form-border)]
                       font-sans text-[15px] text-[var(--nct-form-text)]
                       placeholder:text-[var(--nct-form-placeholder)]
                       focus:outline-none focus:border-amber-500 focus:ring-4
                       focus:ring-amber-500/25
                       transition-[border-color,box-shadow,background-color] duration-200
                       disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="admin-login-password"
                @keydown="onKeydown"
              />
              <button
                type="button"
                :aria-label="showPassword ? 'Jelszó elrejtése' : 'Jelszó megjelenítése'"
                :aria-pressed="showPassword"
                :title="showPassword ? 'Jelszó elrejtése' : 'Jelszó megjelenítése'"
                :disabled="submitting"
                tabindex="0"
                class="absolute right-1.5 top-1/2 -translate-y-1/2
                       h-8 w-8 inline-flex items-center justify-center rounded-md
                       text-[var(--nct-form-text-muted)]
                       hover:text-[var(--nct-form-text)] hover:bg-amber-500/10
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500
                       transition-colors duration-150
                       disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="admin-login-password-toggle"
                @click="togglePasswordVisibility"
              >
                <svg
                  v-if="showPassword"
                  width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true"
                >
                  <path d="M9.88 5.05A10.94 10.94 0 0 1 12 5c5.5 0 9.5 5 10 7-0.16 0.62-0.62 1.66-1.4 2.86" />
                  <path d="M6.61 6.61C4.62 8.07 3.27 10.05 2 12c0.5 2 4.5 7 10 7 1.81 0 3.45-0.43 4.84-1.11" />
                  <path d="M1 1l22 22" />
                  <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
                </svg>
                <svg
                  v-else
                  width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true"
                >
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>

            <div
              v-if="errorText"
              id="admin-login-error"
              class="mt-4 flex items-start gap-2 px-3 py-2.5
                     rounded-lg border border-danger/30
                     bg-danger/10 text-danger
                     text-[13.5px] leading-[1.45]"
              data-testid="admin-login-error"
              role="alert"
            >
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" class="mt-0.5 shrink-0" aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="8" x2="12" y2="13" />
                <line x1="12" y1="16.5" x2="12" y2="16.5" />
              </svg>
              <span>{{ errorText }}</span>
            </div>

            <Button
              variant="primary"
              size="lg"
              type="submit"
              :loading="submitting"
              :disabled="submitDisabled"
              class="w-full mt-5 !bg-amber-500 hover:!bg-amber-600
                     !text-white
                     focus-visible:!ring-amber-500/50
                     shadow-[0_8px_24px_-12px_rgba(245,158,11,0.55)]"
              data-testid="admin-login-submit"
              @click="submit"
            >
              <span class="font-medium tracking-wide">
                {{ submitting ? 'Bejelentkezés…' : 'Admin bejelentkezés' }}
              </span>
            </Button>
          </form>

          <div class="mt-7 flex items-center gap-3 text-[11.5px] text-[var(--nct-form-text-muted)]">
            <span class="h-px flex-1 bg-[var(--nct-form-border)]" />
            <span class="font-mono tracking-wider">NCT belső rendszer · operations</span>
            <span class="h-px flex-1 bg-[var(--nct-form-border)]" />
          </div>

          <!-- Back to dashboard link -->
          <a
            href="/dashboard/v2/ask"
            class="mt-4 flex items-center justify-center gap-2 w-full h-9 rounded-lg
                   border border-[var(--nct-form-border)]
                   text-[13px] font-medium text-[var(--nct-form-text-muted)]
                   hover:text-[var(--nct-form-text)] hover:border-nct-soft/50 hover:bg-nct-500/5
                   transition-colors duration-150
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
            data-testid="admin-login-back"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3L5 8l5 5"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            Vissza a dashboardba
          </a>
        </div>

        <p
          class="hidden md:block mt-6 max-w-[420px] md:ml-auto
                 text-[11.5px] leading-[1.5] text-[var(--nct-form-text-muted)]"
        >
          Az üzemeltetői jelszó a <code class="font-mono">DASHBOARD_PASSWORD</code>
          környezeti változóban van beállítva. A munkamenet 3 perc
          inaktivitás után automatikusan lejár.
        </p>
      </section>
    </main>
  </div>
</template>
