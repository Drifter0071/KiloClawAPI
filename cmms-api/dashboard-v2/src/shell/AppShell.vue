<script setup lang="ts">
// src/shell/AppShell.vue
//
// HIG-flavoured shell (Phase 7).
//
// Layout:
//   - Desktop (>= md): top bar pinned to the top, content scrolls below.
//     AppTopbar shows logo + nav tabs + connection status + operator menu
//     in a single 52px row anchored to the top edge of the viewport.
//   - Mobile (< md): same top bar (logo + status + operator) but the
//     nav lives in a native iOS-style bottom tab bar fixed to the
//     viewport bottom. The chat canvas reserves safe-area-inset-bottom
//     so the last message doesn't slip under the tab bar.
//
// The /login route is exempted — LoginPage owns its own full-bleed
// layout. (See useRoute().path check below.)

import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppTopbar from './AppTopbar.vue'
import BottomTabs from './BottomTabs.vue'
import GlobalBanner from './GlobalBanner.vue'

const route = useRoute()
const isLogin = computed(() => route.path === '/login')
</script>

<template>
  <div
    class="h-screen flex flex-col bg-canvas text-text-primary font-sans antialiased"
    data-testid="app-shell"
  >
    <template v-if="!isLogin">
      <AppTopbar />
      <GlobalBanner />
    </template>

    <main
      class="flex-1 min-h-0 overflow-hidden"
      :class="{ 'pb-16 md:pb-0': !isLogin }"
      data-testid="app-main"
    >
      <router-view />
    </main>

    <BottomTabs v-if="!isLogin" />
  </div>
</template>
