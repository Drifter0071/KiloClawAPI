<script setup lang="ts">
// src/routes/LoginPage.vue
//
// v3 redesign of the operator login. Split composition (left brand
// panel + right form) on desktop, compact stacked header + form on
// mobile. The auth flow is unchanged — same POST to /dashboard/login,
// same sessionStorage key, same router push, same probe.
//
// On desktop the central space is occupied by an animated SVG mascot
// scene (NctMascotScene) that bridges the brand area and the form: it
// floats near the brand, drifts over to the login card, gently touches
// the card's outer border at the 50% keyframe (which triggers a soft
// purple glow pulse on the card), and returns. The loop is seamless
// (0% and 100% match) and respects prefers-reduced-motion.
//
// Selectors kept for the test suite:
//   data-testid="login-page" / "login-card" / "login-password" /
//                  "login-submit" / "login-error"
// Required copy kept for the test suite:
//   "Bejelentkezés" heading
//   "Add meg a hozzáférési jelszót" supporting text
//   "Hibás jelszó." error string

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { humanizeError } from '@/lib/errors'
import { setSessionToken } from '@/composables/useSessionToken'
import { useTheme } from '@/composables/useTheme'
import Button from '@/components/Button.vue'
import NctMascotScene from '@/components/NctMascotScene.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const router = useRouter()
// useTheme is invoked so the composable installs the system-pref
// MediaQueryList listener and the toggle button can drive it. We don't
// need the reactive handle in the template (the bootstrap script +
// data-theme on <html> handle the actual repaint).
useTheme()

const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const errorText = ref<string | null>(null)
const passwordInputRef = ref<HTMLInputElement | null>(null)
const maintenanceActive = ref(false)
// Mirrors the component's mount state. The async onMounted probe runs
// two awaits in sequence; if the user navigates away (or a test
// unmounts us) while the probe is in flight, we must skip the late
// state writes and the follow-up tokens fetch. Without this guard
// the late tokens call would land on the *next* page's global fetch.
const isMounted = ref(true)
onBeforeUnmount(() => { isMounted.value = false })

const submitDisabled = computed(
  () => submitting.value || password.value.length === 0,
)

const SESSION_TOKEN_KEY = 'cmms_dash_token'

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

interface LoginSuccess {
  ok: true
  token?: string
  cookie_set?: boolean
}

interface LoginFailure {
  ok: false
  error?: string
}

type LoginResponse = LoginSuccess | LoginFailure

async function submit() {
  if (submitDisabled.value) return
  submitting.value = true
  errorText.value = null

  try {
    const res = await fetch('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: password.value }),
    })

    // Parse the body regardless of status (the 401 path also returns JSON).
    let body: LoginResponse | null = null
    try {
      body = (await res.json()) as LoginResponse
    } catch {
      body = null
    }

    if (res.ok && body && body.ok) {
      if (body.token) {
        setSessionToken(SESSION_TOKEN_KEY, body.token)
      }
      await router.push('/ask')
      return
    }

    if (body && body.ok === false) {
      errorText.value = body.error === 'wrong password' ? 'Hibás jelszó.' : 'Hibás jelszó.'
    } else {
      errorText.value = 'Hibás jelszó.'
    }
  } catch (err) {
    errorText.value = humanizeError(err).description
  } finally {
    submitting.value = false
    // Restore focus to the password field so keyboard users can retry
    // without reaching for the mouse.
    passwordInputRef.value?.focus()
  }
}

// ---------------------------------------------------------------------------
// UX niceties
// ---------------------------------------------------------------------------

/** Pressing Enter in the password field submits. */
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

/** If the user is already authed (came back with a valid cookie), skip
 *  the login screen — go straight to the Ask page. Also check
 *  maintenance: if active, show the maintenance screen instead. */
onMounted(async () => {
  // Check maintenance state first — if active, show maintenance screen
  try {
    const mR = await fetch('/dashboard/api/maintenance', { credentials: 'same-origin' })
    // Bail out if the component was unmounted while the request was
    // in flight (e.g., a test swapped this page out under us). Without
    // this guard the late tokens probe below would land on the NEXT
    // test's global fetch mock and inflate its call count.
    if (!isMounted.value) return
    if (mR.ok) {
      const mBody = await mR.json() as { enabled?: boolean }
      if (!isMounted.value) return
      if (mBody.enabled) {
        maintenanceActive.value = true
        return // don't check auth or redirect
      }
    }
  } catch {
    // ignore — fall through to normal login flow
  }

  // Re-check the mount state BEFORE issuing the second probe. If the
  // component was unmounted between the maintenance probe and here
  // (e.g., a test tearing down a navigation-flow wrapper), skip the
  // follow-up fetch so it doesn't land on the next test's mock.
  if (!isMounted.value) return

  // If already authed, skip to Ask. Awaited (not fire-and-forget) so
  // the async function's lifecycle is tied to the onMounted scope;
  // awaiting means the test cleanup can drain everything via
  // flushPromises without leaving a stray probe behind.
  try {
    const r = await fetch('/dashboard/api/tokens', { credentials: 'same-origin' })
    if (!isMounted.value) return
    if (r.ok) {
      void router.replace('/ask')
    }
  } catch {
    // Stay on the login page; not authed.
  }
})
</script>

<template>
  <div
    class="nct-theme-transition relative min-h-[100dvh] w-full overflow-x-hidden
           bg-[var(--color-canvas)] text-[var(--nct-form-text)] font-sans antialiased
           flex flex-col"
    data-testid="login-page"
  >
    <!-- ===================== Background field ===================== -->
    <!-- Soft radial light source, fixed, doesn't capture input. Decorative. -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 -z-0 overflow-hidden"
    >
      <div
        class="absolute -top-32 -left-32 w-[42rem] h-[42rem] rounded-full
               bg-[radial-gradient(closest-side,var(--nct-ambient-1),var(--nct-ambient-3))]
               blur-3xl opacity-80 animate-nct-drift"
      />
      <div
        class="absolute -bottom-40 -right-24 w-[36rem] h-[36rem] rounded-full
               bg-[radial-gradient(closest-side,var(--nct-ambient-2),var(--nct-ambient-3))]
               blur-3xl opacity-70 animate-nct-drift"
        style="animation-delay: -3s"
      />
      <!-- Hairline grid (subtle, technical) -->
      <div
        class="absolute inset-0 opacity-[0.06]
               bg-[linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)]
               bg-[size:48px_48px]"
      />
    </div>

    <!-- ===================== Theme toggle (top-right, always accessible) ===================== -->
    <div
      class="relative z-10 flex justify-end w-full
             pt-[max(env(safe-area-inset-top),1.25rem)] pr-5 pb-3
             animate-nct-fade-in"
    >
      <ThemeToggle />
    </div>

    <!-- ===================== MAINTENANCE SCREEN ===================== -->
    <div
      v-if="maintenanceActive"
      class="relative z-10 flex-1 flex flex-col items-center justify-center px-5 animate-nct-fade-up"
      data-testid="maintenance-screen"
    >
      <!-- Builder mascot -->
      <div
        class="w-32 h-32 sm:w-40 sm:h-40 bg-[url('/dashboard/v2/mascot-builder.png')] bg-contain bg-no-repeat bg-center
               drop-shadow-[0_8px_24px_rgba(61,39,92,0.45)] mb-8"
        aria-hidden="true"
      />

      <h1
        class="text-[1.5rem] sm:text-[1.75rem] font-semibold tracking-tight text-[var(--nct-form-text)] text-center mb-3"
      >
        Karbantartás alatt
      </h1>
      <p
        class="max-w-[36ch] text-[15px] leading-[1.6] text-[var(--nct-form-text-muted)] text-center mb-8"
      >
        Jelenleg a rendszer fejlesztése és karbantartása folyik.
        Mindig azon dolgozunk, hogy jobb élményt nyújthassunk.
        Kérjük, legyél türelmes — hamarosan visszatérünk!
      </p>

      <div class="flex items-center gap-2 text-[11px] font-mono tracking-wide text-[var(--nct-form-text-muted)]">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-nct-pulse-glow" />
        NCT Szerviz Ai · karbantartás
      </div>
    </div>

    <!-- ===================== Main split layout (normal login) ===================== -->
    <main
      v-else
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
        aria-labelledby="nct-brand-heading"
      >
        <div>
          <!-- The big animated mascot below is the visual anchor, so the
               small NctMark logo is intentionally omitted here. -->
          <h2
            id="nct-brand-heading"
            class="text-[clamp(1.75rem,2.6vw,2.5rem)] font-semibold leading-[1.1] tracking-tight
                   text-[var(--nct-form-text)]"
          >
            NCT Szerviz Ai <span class="text-[var(--nct-form-text-muted)] font-normal">v2</span>
          </h2>
          <p class="mt-3 mb-6 max-w-[34ch] text-[15px] leading-[1.55] text-[var(--nct-form-text-muted)]">
            Belső karbantartási munkatér — NCT vezérlők és CNC gépek
            szervizének központi kezelőfelülete.
          </p>
        </div>

        <!-- Interactive Mascot Animation Scene (fills the central space & interacts with form wrapper) -->
        <div
          class="relative w-full max-w-[32rem] h-[220px] sm:h-[260px] md:h-[280px] my-3 pointer-events-none overflow-visible"
          aria-hidden="true"
        >
          <NctMascotScene />
        </div>

        <div class="flex items-center gap-3 text-[11px] font-mono tracking-wide text-[var(--nct-form-text-muted)]">
          <span class="w-1.5 h-1.5 rounded-full bg-nct-500 animate-nct-pulse-glow" />
          v2.0 · NCT belső vezérlőpult
        </div>
      </section>

      <!-- ============== Right login panel ============== -->
      <section
        class="flex flex-col justify-center
               min-h-[calc(100dvh-7rem)] md:py-6
               animate-nct-fade-up"
        style="animation-delay: 140ms"
        aria-labelledby="nct-login-heading"
      >
        <div
          class="w-full max-w-[420px] mx-auto md:mx-0 md:ml-auto
                 rounded-2xl border border-[var(--nct-form-border)]
                 bg-[var(--nct-form-bg)]
                 shadow-[0_1px_0_var(--nct-line),0_24px_60px_-20px_rgba(0,0,0,0.45)]
                 backdrop-blur-md animate-nct-card-pulse
                 p-7 sm:p-8 md:p-9"
          data-testid="login-card"
        >
          <!-- Brand chip -->
          <div class="flex items-center gap-2 mb-5">
            <span
              class="inline-flex items-center gap-1.5 h-6 px-2 rounded-full
                     border border-nct-500/25
                     bg-nct-500/10
                     text-[10.5px] font-mono tracking-wider uppercase
                     text-[var(--nct-chip-text)]"
            >
              <span class="w-1 h-1 rounded-full bg-nct-500" />
              belső rendszer
            </span>
          </div>

          <h1
            id="nct-login-heading"
            class="text-[1.6rem] md:text-[1.75rem] font-semibold tracking-tight text-[var(--nct-form-text)] m-0"
          >
            Bejelentkezés
          </h1>
          <p class="mt-1.5 text-[14px] leading-[1.5] text-[var(--nct-form-text-muted)] mb-6">
            Add meg a hozzáférési jelszót a folytatáshoz.
          </p>

          <form
            novalidate
            class="block"
            :aria-busy="submitting || undefined"
            @submit.prevent="submit"
          >
            <label
              for="login-password"
              class="block text-[13px] font-medium text-[var(--nct-form-text)] mb-1.5"
            >
              Jelszó
            </label>
            <div class="relative">
              <input
                id="login-password"
                ref="passwordInputRef"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                required
                autofocus
                :disabled="submitting"
                :aria-invalid="errorText ? 'true' : 'false'"
                aria-describedby="login-error"
                placeholder="••••••••"
                class="w-full h-11 pl-3.5 pr-12 rounded-lg
                       bg-[var(--nct-surface)] border border-[var(--nct-form-border)]
                       font-sans text-[15px] text-[var(--nct-form-text)]
                       placeholder:text-[var(--nct-form-placeholder)]
                       focus:outline-none focus:border-nct-soft focus:ring-4
                       focus:ring-[var(--nct-form-focus-ring)]
                       transition-[border-color,box-shadow,background-color] duration-200
                       disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="login-password"
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
                       hover:text-[var(--nct-form-text)] hover:bg-nct-500/10
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft
                       transition-colors duration-150
                       disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="login-password-toggle"
                @click="togglePasswordVisibility"
              >
                <!-- Eye-off (when password is shown) -->
                <svg
                  v-if="showPassword"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9.88 5.05A10.94 10.94 0 0 1 12 5c5.5 0 9.5 5 10 7-0.16 0.62-0.62 1.66-1.4 2.86" />
                  <path d="M6.61 6.61C4.62 8.07 3.27 10.05 2 12c0.5 2 4.5 7 10 7 1.81 0 3.45-0.43 4.84-1.11" />
                  <path d="M1 1l22 22" />
                  <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
                </svg>
                <!-- Eye (when password is hidden) -->
                <svg
                  v-else
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>

            <div
              v-if="errorText"
              id="login-error"
              class="mt-4 flex items-start gap-2 px-3 py-2.5
                     rounded-lg border border-danger/30
                     bg-danger/10 text-danger
                     text-[13.5px] leading-[1.45]"
              data-testid="login-error"
              role="alert"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="mt-0.5 shrink-0"
                aria-hidden="true"
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
              class="w-full mt-5 !bg-nct-500 hover:!bg-nct-600
                     !text-white
                     focus-visible:!ring-nct-soft/50
                     shadow-[0_8px_24px_-12px_rgba(61,39,92,0.55)]"
              data-testid="login-submit"
              @click="submit"
            >
              <span class="font-medium tracking-wide">
                {{ submitting ? 'Bejelentkezés…' : 'Bejelentkezés' }}
              </span>
            </Button>
          </form>

          <div class="mt-7 flex items-center gap-3 text-[11.5px] text-[var(--nct-form-text-muted)]">
            <span class="h-px flex-1 bg-[var(--nct-form-border)]" />
            <span class="font-mono tracking-wider">NCT belső rendszer</span>
            <span class="h-px flex-1 bg-[var(--nct-form-border)]" />
          </div>
        </div>

        <!-- Subtle footer (desktop only) -->
        <p
          class="hidden md:block mt-6 max-w-[420px] md:ml-auto
                 text-[11.5px] leading-[1.5] text-[var(--nct-form-text-muted)]"
        >
          A hozzáférést a NCT üzemeltetése kezeli. Probléma esetén
          írj a belső üzemeltetési csatornára.
        </p>
      </section>
    </main>
  </div>
</template>
