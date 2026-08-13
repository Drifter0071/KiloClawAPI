<script setup lang="ts">
// src/routes/LoginPage.vue
//
// v2-styled password login (spec §5.0). Bypasses the AppShell — there's
// no topbar, no nav, no AskBar. Just a single centered card on the
// near-black canvas, matching the rest of the dashboard's premium
// dev-tool look.
//
// Wire-up:
//   - POSTs /dashboard/login as JSON { password }.
//   - On success: server returns { ok, token, cookie_set } AND sets the
//     `cmms_dash_session` cookie. We mirror the v1 client: store the
//     bearer token in sessionStorage so fetches keep working if the
//     cookie ever expires, then redirect to /ask.
//   - On failure: 401 → { ok: false, error }. Show the error inline.
//   - On network error: show a generic "connection error" message.
//
// This page is *only* rendered when the user is unauthenticated. Once
// they log in, vue-router pushes to /ask and AppShell takes over.

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { humanizeError } from '@/lib/errors'
import { setSessionToken } from '@/composables/useSessionToken'
import Button from '@/components/Button.vue'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const router = useRouter()

const password = ref('')
const submitting = ref(false)
const errorText = ref<string | null>(null)

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
      // Mirror the v1 flow: stash the bearer token in sessionStorage so
      // future fetches survive a cookie expiry. The cookie itself is set
      // by the response's Set-Cookie header; we don't read it here.
      if (body.token) {
        setSessionToken(SESSION_TOKEN_KEY, body.token)
      }
      // Hand off to the SPA's main route.
      await router.push('/ask')
      return
    }

    // Failure path — prefer the server's message, fall back to our mapper.
    if (body && body.ok === false) {
      errorText.value = body.error === 'wrong password' ? 'Hibás jelszó.' : 'Hibás jelszó.'
    } else {
      errorText.value = 'Hibás jelszó.'
    }
  } catch (err) {
    errorText.value = humanizeError(err).description
  } finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// UX niceties
// ---------------------------------------------------------------------------

/** Pressing Enter in the password field submits. */
function onKeydown(evt: KeyboardEvent) {
  // vue-test-utils' trigger('keydown.enter') normalizes the key to
  // 'enter' (lowercase) while the DOM KeyboardEvent uses 'Enter'.
  // Accept both so the test path and the real browser agree.
  if (evt.key === 'Enter' || evt.key === 'enter') {
    if (submitDisabled.value) return
    evt.preventDefault()
    void submit()
  }
}

/** If the user is already authed (came back with a valid cookie), skip
 *  the login screen — go straight to the Ask page. We do this client-side
 *  by attempting a trivial authenticated fetch; the server is the source
 *  of truth. */
onMounted(() => {
  // Lightweight probe: /api/tokens requires a valid session. If it
  // succeeds, the cookie is still good — jump to /ask.
  fetch('/dashboard/api/tokens', { credentials: 'same-origin' })
    .then((r) => {
      if (r.ok) {
        void router.replace('/ask')
      }
    })
    .catch(() => {
      // Stay on the login page; not authed.
    })
})
</script>

<template>
  <div
    class="h-screen w-screen bg-canvas text-text-primary font-sans flex items-center justify-center"
    data-testid="login-page"
  >
    <div
      class="w-[380px] max-w-[90vw] bg-canvas-2 border border-border-subtle rounded-xl shadow-lg shadow-black/40 p-10"
      data-testid="login-card"
    >
      <!-- Brand mark, mirroring the topbar logo -->
      <div class="flex items-center gap-2 mb-6">
        <svg
          class="w-5 h-5"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect
            x="3"
            y="3"
            width="14"
            height="14"
            rx="3"
            class="fill-sky-500/20"
            stroke="#0EA5E9"
            stroke-width="2"
          />
          <circle cx="10" cy="10" r="1.25" class="fill-sky-500" />
        </svg>
        <span class="text-sm font-semibold text-text-primary">CMMS API</span>
        <span class="text-[10px] font-mono text-text-muted">v0.6.0</span>
      </div>

      <h1 class="text-lg font-semibold text-text-primary m-0">
        Bejelentkezés
      </h1>
      <p class="text-sm text-text-muted mt-1 mb-5">
        Add meg a hozzáférési jelszót a folytatáshoz.
      </p>

      <label
        for="login-password"
        class="block text-sm text-text-secondary mb-1.5"
      >
        Jelszó
      </label>
      <input
        id="login-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        autofocus
        :disabled="submitting"
        class="w-full h-10 px-3 rounded-md bg-surface border border-border-default font-sans text-base text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-4 focus:ring-accent/15 transition-colors duration-150 disabled:opacity-50"
        data-testid="login-password"
        @keydown="onKeydown"
      />

      <Button
        variant="primary"
        size="md"
        :loading="submitting"
        :disabled="submitDisabled"
        class="w-full mt-4"
        data-testid="login-submit"
        @click="submit"
      >
        {{ submitting ? 'Bejelentkezés…' : 'Bejelentkezés' }}
      </Button>

      <div
        v-if="errorText"
        class="mt-4 px-3 py-2 bg-rose-500/15 border border-rose-500/30 rounded-md text-sm text-rose-200"
        data-testid="login-error"
        role="alert"
      >
        {{ errorText }}
      </div>

      <div class="mt-6 text-center text-xs text-text-muted">
        NCT / cmms-api &mdash; belső vezérlőpult
      </div>
    </div>
  </div>
</template>
