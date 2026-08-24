import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastVariant = 'error' | 'warning' | 'info' | 'success'

export type ToastItem = {
  id: number
  variant: ToastVariant
  message: string
  createdAt: number
  /** When set, the toast renders a "Visszavonás" action that calls
   *  `action()` and dismisses itself. Used for undo affordances on
   *  destructive operations (Phase 8, 2026-08-24). */
  actionLabel?: string
  action?: () => void | Promise<void>
}

/** Auto-dismiss delay for toasts (5s, per spec §3.8). */
export const TOAST_TTL_MS = 5000

/**
 * Toast queue store (Phase 3, plan §3.8).
 *
 * Holds a small ring of transient toast notifications. Items auto-dismiss
 * after `TOAST_TTL_MS` via `setTimeout`. The container component
 * (`Toast.vue`) reads `items` reactively and renders a fixed top-right
 * stack; consumers call `error()` / `warn()` / `info()` / `success()`
 * from the `useToast()` composable to push new toasts.
 */
export const useToastStore = defineStore('toast', () => {
  const items = ref<ToastItem[]>([])
  let nextId = 1

  function push(
    variant: ToastVariant,
    message: string,
    extras: { actionLabel?: string; action?: () => void | Promise<void>; ttlMs?: number } = {},
  ) {
    const id = nextId++
    const createdAt = Date.now()
    items.value.push({
      id,
      variant,
      message,
      createdAt,
      actionLabel: extras.actionLabel,
      action: extras.action,
    })
    const ttl = extras.ttlMs ?? TOAST_TTL_MS
    if (ttl > 0) setTimeout(() => dismiss(id), ttl)
  }

  function dismiss(id: number) {
    items.value = items.value.filter((it) => it.id !== id)
  }

  return { items, push, dismiss }
})
