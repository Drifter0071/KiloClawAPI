import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastVariant = 'error' | 'warning' | 'info'

export type ToastItem = {
  id: number
  variant: ToastVariant
  message: string
  createdAt: number
}

/** Auto-dismiss delay for toasts (5s, per spec §3.8). */
export const TOAST_TTL_MS = 5000

/**
 * Toast queue store (Phase 3, plan §3.8).
 *
 * Holds a small ring of transient toast notifications. Items auto-dismiss
 * after `TOAST_TTL_MS` via `setTimeout`. The container component
 * (`Toast.vue`) reads `items` reactively and renders a fixed top-right
 * stack; consumers call `error()` / `warn()` / `info()` from the
 * `useToast()` composable to push new toasts.
 */
export const useToastStore = defineStore('toast', () => {
  const items = ref<ToastItem[]>([])
  let nextId = 1

  function push(variant: ToastVariant, message: string) {
    const id = nextId++
    const createdAt = Date.now()
    items.value.push({ id, variant, message, createdAt })
    setTimeout(() => dismiss(id), TOAST_TTL_MS)
  }

  function dismiss(id: number) {
    items.value = items.value.filter((it) => it.id !== id)
  }

  return { items, push, dismiss }
})
