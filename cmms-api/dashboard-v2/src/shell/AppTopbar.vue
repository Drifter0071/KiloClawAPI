<script setup lang="ts">
// src/shell/AppTopbar.vue
//
// 52px top bar for the v2 chat shell.
//
// Layout (left to right):
//   [hamburger (mobile) | brand wordmark] … [conversation title (center)] … [connection + theme + operator]
//
// The hamburger is only rendered on mobile (< md) and emits `open-rail`
// so the parent (AppShell) can open the ResponsiveDrawer that hosts the
// ConversationRail. On desktop the rail is always visible so the
// hamburger is hidden.
//
// Theme inherits from useTheme (the bootstrap script in index.html sets
// the data-theme attribute on <html> before Vue mounts).

import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAskStore } from '@/stores/ask'
import { useMediaQuery } from '@/composables/useMediaQuery'
import ThemeToggle from '@/components/ThemeToggle.vue'

const route = useRoute()
const store = useAskStore()
const isMobile = useMediaQuery('(max-width: 767px)')

// Show the active thread title when on /ask, otherwise the current
// route's friendly name. Keeps the topbar honest about what the user
// is looking at.
const titleText = computed(() => {
  if (route.path === '/ask') return store.activeTitle
  const map: Record<string, string> = {
    stream: 'Stream',
    map: 'Térkép',
    diff: 'Diff',
    tokens: 'Tokenek',
  }
  return map[route.path.replace(/^\//, '')] ?? 'NCT Szerviz Ai'
})
</script>

<template>
  <header
    class="h-13 shrink-0 sticky top-0 z-30 flex items-center gap-2 md:gap-3
           px-3 md:px-5
           bg-shell-topbar backdrop-blur-xl
           border-b border-shell-divider
           shadow-topbar"
    data-testid="app-topbar"
  >
    <!-- Brand wordmark / page title + subtitle -->
    <div class="flex items-center gap-2 min-w-0 flex-1">
      <div class="flex flex-col min-w-0">
        <span
          class="text-[13px] font-semibold tracking-tight text-shell-rail-text truncate"
          data-testid="topbar-title"
        >
          {{ titleText }}
        </span>
        <span
          class="text-[10px] font-mono tracking-wider text-shell-rail-muted truncate"
        >
          NCT Szerviz Ai · v2
        </span>
      </div>
    </div>

    <!-- Right cluster -->
    <div class="flex items-center gap-2 shrink-0">
      <ThemeToggle />
    </div>
  </header>
</template>
