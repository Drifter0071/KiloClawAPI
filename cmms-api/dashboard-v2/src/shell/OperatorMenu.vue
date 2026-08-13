<script setup lang="ts">
// src/shell/OperatorMenu.vue
//
// Operator avatar button in the topbar (Phase 7).
//
// HIG pattern: a small avatar / initial-button that opens a single
// popover with the operator's session info and a Kijelentkezés (logout)
// action. The popover is positioned under the button; clicking outside
// or pressing Escape closes it.
//
// Logout: the previous v1 used a native <form method="POST"> which
// worked in old Chromium but broke under the Vue v-if / Teleport popover
// lifecycle — closing `open` synchronously from the @submit handler
// removed the form from the DOM before the browser could dispatch the
// POST. We now do the POST via `fetch()` from the click handler:
//   1. fetch('/dashboard/logout', { method: 'POST', credentials: 'same-origin' })
//   2. server returns 302 to /dashboard/v2/login with Set-Cookie: clearCookie
//      → the browser follows the 302, but the fetch follow is blocked
//      because credentials: 'same-origin' + redirect on POST lands the
//      user on the login page. Even if the 302 were ignored, we
//      explicitly navigate via window.location after the POST resolves.
//   3. clear the sessionStorage token (it would otherwise re-attach the
//      user to the new session via the LoginPage probe).
//   4. window.location.assign('/dashboard/v2/login') so the SPA reloads
//      to a clean state with no authed user.

import { onBeforeUnmount, onMounted, ref } from 'vue'
import { clearSessionToken } from '@/composables/useSessionToken'

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const loggingOut = ref(false)

function handleDocumentClick(event: MouseEvent) {
  if (!open.value) return
  const target = event.target as Node | null
  if (root.value && target && !root.value.contains(target)) {
    open.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    open.value = false
  }
}

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  // Close the popover first so a second click doesn't re-trigger.
  open.value = false
  // Clear the local sessionStorage token immediately so the upcoming
  // page reload doesn't see a stale bearer token. The cookie is
  // cleared by the server in the same POST.
  clearSessionToken()
  try {
    // credentials: 'same-origin' so the cookie is sent and the
    // server's Set-Cookie response is accepted. redirect: 'manual'
    // because we want to navigate explicitly, not let the browser
    // follow the 302 (it does, but a manual location.assign gives a
    // cleaner full-page reload — no SPA hydration race).
    await fetch('/dashboard/logout', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
    })
  } catch {
    // Network error — the cookie may or may not have been cleared.
    // Either way, navigate to login so the operator can't see the
    // protected UI any longer.
  }
  // Hard-navigate to the login page. Using location.assign rather
  // than router.push so the SPA fully reloads — Pinia stores,
  // useQuery caches, and any in-memory state are wiped clean.
  window.location.assign('/dashboard/v2/login')
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="w-7 h-7 rounded-full bg-surface-2 border border-border-default text-[11px] font-semibold tracking-tight text-text-primary hover:border-border-strong transition-colors duration-150 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-label="`Operátor menü, állapot: ${open ? 'nyitva' : 'zárva'}`"
      data-testid="operator-menu"
      :disabled="loggingOut"
      @click="open = !open"
    >
      OP
    </button>

    <div
      v-if="open"
      class="absolute right-0 mt-2 w-56 bg-canvas-2 border border-border-default rounded-lg shadow-lg shadow-black/50 p-2 z-50"
      role="menu"
      data-testid="operator-menu-popover"
    >
      <div class="px-2 py-2 flex items-center gap-2.5">
        <span
          class="w-8 h-8 rounded-full bg-accent/15 border border-accent/40 flex items-center justify-center text-[11px] font-semibold text-accent"
          aria-hidden="true"
        >
          OP
        </span>
        <div class="min-w-0">
          <div class="text-[13px] font-medium text-text-primary leading-tight">operátor</div>
          <div class="text-[11px] text-text-muted leading-tight mt-0.5">cmms-api dashboard</div>
        </div>
      </div>
      <div class="h-px bg-border-subtle my-1" aria-hidden="true"></div>
      <button
        type="button"
        class="w-full text-left px-2 py-1.5 text-[13px] text-text-primary hover:bg-surface rounded-md transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed"
        role="menuitem"
        :disabled="loggingOut"
        data-testid="operator-menu-logout"
        @click="logout"
      >
        {{ loggingOut ? 'Kijelentkezés…' : 'Kijelentkezés' }}
      </button>
    </div>
  </div>
</template>
