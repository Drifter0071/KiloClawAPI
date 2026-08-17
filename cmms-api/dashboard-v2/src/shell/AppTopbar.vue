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
import ConnectionStatus from './ConnectionStatus.vue'
import OperatorMenu from './OperatorMenu.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

const emit = defineEmits<{
  (e: 'open-rail'): void
}>()

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

const titleSub = computed(() => {
  if (route.path === '/ask') return 'v2 · belső karbantartási'
  return 'NCT Szerviz Ai v2'
})

function openRail() {
  emit('open-rail')
}
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
    <!-- Mobile hamburger (only < md) -->
    <button
      v-if="isMobile"
      type="button"
      class="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-md
             text-shell-rail-muted
             hover:text-shell-rail-text hover:bg-shell-rail-hover
             focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
             transition-colors duration-150"
      aria-label="Beszélgetések megnyitása"
      title="Beszélgetések"
      data-testid="topbar-rail-toggle"
      @click="openRail"
    >
      <svg
        class="w-5 h-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="17" x2="14" y2="17" />
      </svg>
    </button>

    <!-- Brand wordmark / page title -->
    <div class="flex items-center gap-2 min-w-0 flex-1">
      <div class="flex flex-col min-w-0">
        <span
          class="text-[13px] font-semibold tracking-tight text-shell-rail-text truncate"
          data-testid="topbar-title"
        >
          {{ titleText }}
        </span>
        <span
          class="text-[10px] font-mono uppercase tracking-wider text-shell-rail-muted truncate hidden sm:block"
        >
          {{ titleSub }}
        </span>
      </div>
    </div>

    <!-- Right cluster -->
    <div class="flex items-center gap-2 shrink-0">
      <ConnectionStatus />
      <ThemeToggle />
      <OperatorMenu />
    </div>
  </header>
</template>
