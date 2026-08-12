<script setup lang="ts">
import { computed } from 'vue'
import { useToastStore, type ToastItem, type ToastVariant } from '@/stores/toast'

/**
 * Fixed top-right stack of transient toasts (plan §3.8).
 *
 * Mounts exactly once near the app root. Reads `items` from the toast
 * Pinia store and renders each as a small card. Use `useToast()` from
 * `@/composables/useToast` to push new items; each item auto-dismisses
 * after 5s on the store side.
 */
const store = useToastStore()

const variantBorderClass: Record<ToastVariant, string> = {
  info: 'border-l-4 border-l-accent',
  warning: 'border-l-4 border-l-warning',
  error: 'border-l-4 border-l-danger',
}

const variantLabel: Record<ToastVariant, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
}

const items = computed<ToastItem[]>(() => store.items)
</script>

<template>
  <div
    class="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    data-testid="toast-container"
    aria-live="polite"
    aria-atomic="false"
  >
    <div
      v-for="item in items"
      :key="item.id"
      :class="[
        'bg-canvas-2 border border-border-default rounded-lg shadow-lg shadow-black/40 p-3 text-sm text-text-primary max-w-sm pointer-events-auto',
        variantBorderClass[item.variant],
      ]"
      :data-testid="`toast-${item.variant}`"
      :data-toast-id="item.id"
      role="status"
    >
      <div class="flex items-start gap-2">
        <span
          class="font-mono text-[10px] uppercase tracking-wider mt-0.5"
          :class="item.variant === 'error' ? 'text-danger' : item.variant === 'warning' ? 'text-warning' : 'text-accent'"
        >{{ variantLabel[item.variant] }}</span>
        <span class="flex-1 break-words">{{ item.message }}</span>
        <button
          type="button"
          class="text-text-muted hover:text-text-primary text-xs"
          aria-label="Dismiss"
          :data-testid="`toast-dismiss-${item.id}`"
          @click="store.dismiss(item.id)"
        >✕</button>
      </div>
    </div>
  </div>
</template>
