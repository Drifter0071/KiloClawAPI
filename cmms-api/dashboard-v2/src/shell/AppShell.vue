<script setup lang="ts">
// src/shell/AppShell.vue
//
// V2 chat shell — three regions on desktop, single column on mobile.
//
// Desktop (>= md):
//   ┌────────────┬───────────────────────────────────────────┐
//   │            │  AppTopbar (compact header)               │
//   │ Conversation├───────────────────────────────────────────┤
//   │ Rail       │  Chat workspace (scrollable)               │
//   │ (left, 280)│  + composer pinned to bottom              │
//   │            │                                           │
//   └────────────┴───────────────────────────────────────────┘
//
// Mobile (< md):
//   - Bottom tab bar replaces the desktop rail
//   - Composer is sticky to the bottom
//   - Ticket inspector is a full-width sheet (TicketInspector owns
//     this on the Ask page; the shell doesn't intervene)
//
// Theme is inherited from useTheme() (see src/composables/useTheme.ts).
// The login route is exempted — LoginPage owns its own full-bleed
// layout.
//
// On mount, we probe /dashboard/api/maintenance (public, no auth).
// If maintenance is active, ALL operator sessions are force-logged-out
// and the user is bounced to the login page which shows the
// maintenance screen with the builder mascot.

import { computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { clearSessionToken } from '@/composables/useSessionToken'
import AppTopbar from './AppTopbar.vue'
import BottomTabs from './BottomTabs.vue'
import ConversationRail from './ConversationRail.vue'
import GlobalBanner from './GlobalBanner.vue'

const route = useRoute()
const router = useRouter()
const isLogin = computed(() => route.path === '/login')
const isMobile = computed(() => {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(max-width: 767px)').matches
})

// Probe maintenance on mount — if active, force logout and redirect
// to login. The login page independently checks maintenance too and
// shows the builder mascot + friendly message instead of the form.
onMounted(async () => {
  if (isLogin.value) return // login page handles its own check
  try {
    const r = await fetch('/dashboard/api/maintenance', { credentials: 'same-origin' })
    if (r.ok) {
      const body = await r.json() as { enabled?: boolean }
      if (body.enabled) {
        // Force logout: clear session token, clear cookie via server,
        // bounce to login.
        clearSessionToken()
        await fetch('/dashboard/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
        await router.replace('/login')
      }
    }
  } catch {
    // Network error — let the existing GlobalBanner handle it
  }
})
</script>

<template>
  <div
    class="h-screen h-dvh flex bg-chat-read text-chat-read-text font-sans antialiased overflow-hidden"
    data-testid="app-shell"
  >
    <template v-if="!isLogin">
      <!-- Desktop rail (left, fixed) -->
      <aside
        v-if="!isMobile"
        class="w-[280px] shrink-0 border-r border-shell-rail-border bg-shell-rail"
        data-testid="app-rail-desktop"
      >
        <ConversationRail />
      </aside>

      <!-- Main column -->
      <div class="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        <AppTopbar />
        <GlobalBanner />
        <main
          class="flex-1 min-h-0 flex flex-col overflow-hidden pb-14 md:pb-0"
          data-testid="app-main"
        >
          <router-view />
        </main>
      </div>

      <!-- Mobile bottom tab bar (replaces the desktop top nav on phones) -->
      <BottomTabs v-if="isMobile" />
    </template>

    <template v-else>
      <main class="flex-1 min-h-0 overflow-hidden" data-testid="app-main">
        <router-view />
      </main>
    </template>
  </div>
</template>
