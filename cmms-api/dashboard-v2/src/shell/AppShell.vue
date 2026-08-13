<script setup lang="ts">
// src/shell/AppShell.vue
//
// The chrome around every page in the SPA. The topbar + nav + global
// banner are hidden on the /login route — that page renders its own
// full-bleed layout. All other routes get the full chrome.

import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppTopbar from './AppTopbar.vue'
import GlobalBanner from './GlobalBanner.vue'

const route = useRoute()
const isLogin = computed(() => route.path === '/login')
</script>

<template>
  <div class="h-screen flex flex-col bg-canvas text-text-primary font-sans">
    <template v-if="!isLogin">
      <AppTopbar />
      <GlobalBanner />
    </template>
    <main class="flex-1 overflow-auto">
      <router-view />
    </main>
  </div>
</template>
