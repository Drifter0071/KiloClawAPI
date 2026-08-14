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
//   - Conversation rail is a drawer (hamburger in the topbar)
//   - Composer is sticky to the bottom
//   - Ticket inspector is a full-width sheet (TicketInspector owns
//     this on the Ask page; the shell doesn't intervene)
//
// Theme is inherited from useTheme() (see src/composables/useTheme.ts).
// The login route is exempted — LoginPage owns its own full-bleed
// layout.

import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMediaQuery } from '@/composables/useMediaQuery'
import AppTopbar from './AppTopbar.vue'
import ConversationRail from './ConversationRail.vue'
import ResponsiveDrawer from '@/components/ResponsiveDrawer.vue'
import GlobalBanner from './GlobalBanner.vue'

const route = useRoute()
const isLogin = computed(() => route.path === '/login')

const isMobile = useMediaQuery('(max-width: 767px)')
const railOpen = ref(false)

function closeRail() {
  railOpen.value = false
}

// Auto-close the mobile drawer on navigation so the user sees the
// chat they just selected (without an explicit "close" tap).
watch(
  () => route.fullPath,
  () => {
    if (isMobile.value) railOpen.value = false
  },
)
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
        <AppTopbar @open-rail="railOpen = true" />
        <GlobalBanner />
        <main
          class="flex-1 min-h-0 flex flex-col overflow-hidden"
          data-testid="app-main"
        >
          <router-view />
        </main>
      </div>

      <!-- Mobile rail drawer -->
      <ResponsiveDrawer
        :open="railOpen && isMobile"
        side="left"
        width-class="md:w-[300px]"
        aria-label="Beszélgetések és navigáció"
        @update:open="closeRail"
      >
        <!--
          Do NOT close on bubbled clicks here — that would dismiss the
          drawer the moment the user taps the search field or any
          non-nav control inside the rail. The drawer closes correctly
          via:
            1. The ResponsiveDrawer's scrim click (`update:open(false)`)
            2. The Escape key (handled inside ResponsiveDrawer)
            3. A route change triggered by a nav button or thread pick
               (the watcher on route.fullPath above)
        -->
        <ConversationRail />
      </ResponsiveDrawer>
    </template>

    <template v-else>
      <main class="flex-1 min-h-0 overflow-hidden" data-testid="app-main">
        <router-view />
      </main>
    </template>
  </div>
</template>
