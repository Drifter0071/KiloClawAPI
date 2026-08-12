<script setup lang="ts">
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
      class="h-7 px-2.5 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary text-sm flex items-center gap-1"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="open = !open"
    >
      <span>OP</span>
      <span aria-hidden="true">▾</span>
    </button>

    <div
      v-if="open"
      class="absolute right-0 mt-2 w-56 bg-canvas-2 border border-border-subtle rounded-lg shadow-lg shadow-black/40 p-2 z-50"
      role="menu"
    >
      <div class="px-2 py-1.5 text-xs text-text-muted">operator</div>
      <div class="h-px bg-border-subtle my-1" aria-hidden="true"></div>
      <form method="POST" action="/dashboard/logout" @submit="open = false">
        <button
          type="submit"
          class="w-full text-left px-2 py-1.5 text-sm text-text-primary hover:bg-surface rounded-md"
          role="menuitem"
        >
          Sign out
        </button>
      </form>
    </div>
  </div>
</template>
