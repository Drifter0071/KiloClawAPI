<script setup lang="ts">
// src/components/AskThreadBar.vue
//
// Compact toolbar for the Ask page composer:
//   left  — per-client thread switcher (current thread pill + popover
//           listing every known thread with its message count; "Törlés"
//           clears the ACTIVE thread's history)
//   right — "AI átírás" render-only LLM toggle (default off; the
//           deterministic answer path stays the source of truth)
//
// All state lives in the ask Pinia store; this component is pure UI.
// Used in both the empty-state hero and the sticky composer.

import { ref } from 'vue'
import { useAskStore, GENERAL_KEY, threadLabel } from '@/stores/ask'

const store = useAskStore()
const menuOpen = ref(false)

function pick(key: string) {
  store.switchThread(key)
  menuOpen.value = false
}
</script>

<template>
  <div class="flex items-center justify-between gap-3" data-testid="ask-thread-bar">
    <!-- Thread switcher -->
    <div class="relative">
      <button
        type="button"
        class="flex items-center gap-2 h-8 px-2.5 rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :aria-expanded="menuOpen"
        aria-haspopup="true"
        data-testid="thread-switcher"
        @click="menuOpen = !menuOpen"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-accent" />
        <span class="text-xs font-medium truncate max-w-[180px]">{{ threadLabel(store.threadKey) }}</span>
        <svg
          class="w-3 h-3 text-text-muted shrink-0"
          viewBox="0 0 12 12"
          fill="none"
          :class="menuOpen ? 'rotate-180' : ''"
          aria-hidden="true"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <div v-if="menuOpen" class="fixed inset-0 z-40" data-testid="thread-menu-backdrop" @click="menuOpen = false" />
      <div
        v-if="menuOpen"
        class="absolute bottom-full left-0 mb-2 z-50 w-72 rounded-xl bg-surface border border-border-subtle shadow-xl shadow-black/20 overflow-hidden"
        data-testid="thread-menu"
      >
        <div class="px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Beszélgetések
        </div>
        <div class="max-h-56 overflow-y-auto py-1">
          <button
            v-for="t in store.index"
            :key="t.key"
            type="button"
            class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2 transition-colors duration-100"
            :class="t.key === store.threadKey ? 'bg-surface-2' : ''"
            :data-testid="`thread-option-${t.key}`"
            @click="pick(t.key)"
          >
            <span class="text-[13px] text-text-primary truncate">{{ t.label }}</span>
            <span class="text-[10px] font-mono text-text-muted tabular-nums shrink-0">{{ t.count }}</span>
          </button>
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2 transition-colors duration-100"
            :class="GENERAL_KEY === store.threadKey ? 'bg-surface-2' : ''"
            data-testid="thread-option-general"
            @click="pick(GENERAL_KEY)"
          >
            <span class="text-[13px] text-text-primary">General</span>
            <span class="text-[10px] font-mono text-text-muted tabular-nums shrink-0">
              {{ store.index.find((t) => t.key === GENERAL_KEY)?.count ?? 0 }}
            </span>
          </button>
        </div>
        <div class="border-t border-border-subtle/60 py-1">
          <button
            type="button"
            class="w-full px-3 py-2 text-left text-[13px] text-danger hover:bg-danger/10 transition-colors duration-100"
            data-testid="thread-clear"
            @click="store.clearThread(); menuOpen = false"
          >
            Törlés
          </button>
        </div>
      </div>
    </div>

    <!-- Render-only LLM toggle -->
    <button
      type="button"
      role="switch"
      :aria-checked="store.llmOn"
      class="flex items-center gap-2 h-8 px-2.5 rounded-md hover:bg-surface transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      data-testid="llm-toggle"
      @click="store.llmOn = !store.llmOn"
    >
      <span
        class="w-7 h-4 rounded-full relative transition-colors duration-150"
        :class="store.llmOn ? 'bg-accent' : 'bg-border-strong'"
      >
        <span
          class="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform duration-150"
          :class="store.llmOn ? 'translate-x-3' : ''"
        />
      </span>
      <span class="text-xs font-medium text-text-secondary" :class="store.llmOn ? 'text-text-primary' : ''">
        AI átírás
      </span>
    </button>
  </div>
</template>
