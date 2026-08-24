<script setup lang="ts">
import { computed, ref } from 'vue'
import { useToastStore, type ToastItem, type ToastVariant } from '@/stores/toast'

/**
 * Fixed top-right stack of transient toasts (plan §3.8).
 *
 * Mounts exactly once near the app root. Reads `items` from the toast
 * Pinia store and renders each as a small card. Use `useToast()` from
 * `@/composables/useToast` to push new items; each item auto-dismisses
 * after 5s on the store side.
 *
 * Mobile-first (2026-08-24): each card supports a vertical drag-down
 * gesture to dismiss. The drag is purely visual; we don't animate the
 * container because the cards live in a flex column, not a known
 * offset. Drag > 60px or velocity > 0.4 → dismiss. Below the threshold
 * the card snaps back.
 *
 * Undo affordance (Phase 8, 2026-08-24): toasts can carry an `action`
 * + `actionLabel`; the card renders a "Visszavonás" link next to the
 * message. Tapping the action calls the callback and dismisses the
 * toast. Used after destructive ops (ticket close, tag remove) so the
 * user can revert in one tap.
 */
const store = useToastStore()

const variantBorderClass: Record<ToastVariant, string> = {
  info: 'border-l-4 border-l-accent',
  warning: 'border-l-4 border-l-warning',
  error: 'border-l-4 border-l-danger',
  success: 'border-l-4 border-l-success',
}

const variantLabel: Record<ToastVariant, string> = {
  info: 'Infó',
  warning: 'Figyelem',
  error: 'Hiba',
  success: 'Kész',
}

const items = computed<ToastItem[]>(() => store.items)

// Per-item drag state (the v-for needs a stable ref map keyed by id).
const dragY = ref<Record<number, number>>({})
let startY = 0
let lastY = 0
let lastT = 0
let activeId: number | null = null

function onTouchStart(id: number, e: TouchEvent) {
  if (e.touches.length !== 1) return
  activeId = id
  startY = e.touches[0]!.clientY
  lastY = startY
  lastT = Date.now()
  dragY.value[id] = 0
}
function onTouchMove(id: number, e: TouchEvent) {
  if (activeId !== id || e.touches.length !== 1) return
  const y = e.touches[0]!.clientY
  lastY = y
  lastT = Date.now()
  // Only allow downward drag.
  const dy = Math.max(0, y - startY)
  dragY.value[id] = dy
}
function onTouchEnd(id: number) {
  if (activeId !== id) return
  const dy = dragY.value[id] ?? 0
  const dt = Math.max(1, Date.now() - lastT)
  const v = (lastY - startY) / dt // px / ms
  activeId = null
  if (dy > 60 || v > 0.4) {
    store.dismiss(id)
  }
  // Snap back: schedule a reset on the next tick so the leave animation
  // doesn't fight a non-zero transform.
  setTimeout(() => {
    dragY.value[id] = 0
  }, 200)
}

async function runAction(item: ToastItem) {
  if (!item.action) return
  try {
    await item.action()
  } finally {
    store.dismiss(item.id)
  }
}
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
        'bg-canvas-2 border border-border-default rounded-lg shadow-lg shadow-black/40 p-3 text-sm text-text-primary max-w-sm pointer-events-auto touch-none',
        variantBorderClass[item.variant],
      ]"
      :style="{ transform: `translateY(${dragY[item.id] ?? 0}px)`, opacity: (dragY[item.id] ?? 0) > 0 ? Math.max(0.2, 1 - (dragY[item.id] ?? 0) / 120) : 1 }"
      :data-testid="`toast-${item.variant}`"
      :data-toast-id="item.id"
      role="status"
      @touchstart.passive="onTouchStart(item.id, $event)"
      @touchmove.passive="onTouchMove(item.id, $event)"
      @touchend="onTouchEnd(item.id)"
    >
      <div class="flex items-start gap-2">
        <span
          class="font-mono text-[10px] uppercase tracking-wider mt-0.5"
          :class="item.variant === 'error' ? 'text-danger' : item.variant === 'warning' ? 'text-warning' : item.variant === 'success' ? 'text-success' : 'text-accent'"
        >{{ variantLabel[item.variant] }}</span>
        <div class="flex-1 min-w-0 break-words">
          <span>{{ item.message }}</span>
          <button
            v-if="item.action && item.actionLabel"
            type="button"
            class="ml-2 inline-flex items-center font-medium text-nct-soft hover:text-nct-soft/80 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40 rounded"
            :data-testid="`toast-undo-${item.id}`"
            @click="runAction(item)"
          >
            {{ item.actionLabel }}
          </button>
        </div>
        <button
          type="button"
          class="text-text-muted hover:text-text-primary text-xs"
          aria-label="Bezárás"
          :data-testid="`toast-dismiss-${item.id}`"
          @click="store.dismiss(item.id)"
        >✕</button>
      </div>
    </div>
  </div>
</template>
