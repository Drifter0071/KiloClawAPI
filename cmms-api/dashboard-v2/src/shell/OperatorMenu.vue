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
// We intentionally keep this small — there's no theme switcher or
// settings list inside. The popover is just a profile + logout combo.

import { onBeforeUnmount, onMounted, ref } from 'vue'

const open = ref(false)
const root = ref<HTMLElement | null>(null)

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
      <form method="POST" action="/dashboard/logout" @submit="open = false">
        <button
          type="submit"
          class="w-full text-left px-2 py-1.5 text-[13px] text-text-primary hover:bg-surface rounded-md transition-colors duration-150"
          role="menuitem"
          data-testid="operator-menu-logout"
        >
          Kijelentkezés
        </button>
      </form>
    </div>
  </div>
</template>
