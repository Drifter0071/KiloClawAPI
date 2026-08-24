// src/composables/useToast.ts
//
// Tiny composable that wraps the toast Pinia store with ergonomic
// variants. Importable as `import { useToast } from '@/composables/useToast'`.
//
// The Toast container component (src/components/Toast.vue) reads the
// same store; the composable is the only thing consumers use to push
// new toasts. Items auto-dismiss after TOAST_TTL_MS (5s) on the store
// side, and can also be dismissed manually via `dismiss(id)`.
//
// `successWithUndo` (Phase 8, 2026-08-24) shows a green confirmation
// toast with a "Visszavonás" action — used after destructive ops
// (closing a ticket, removing a tag, …) so the user can revert in
// one tap without a confirm dialog.

import { useToastStore, type ToastItem } from '@/stores/toast'

export function useToast() {
  const store = useToastStore()
  return {
    error: (msg: string) => store.push('error', msg),
    warn: (msg: string) => store.push('warning', msg),
    info: (msg: string) => store.push('info', msg),
    success: (msg: string) => store.push('success', msg),
    /**
     * Show a "X törölve · Visszavonás" toast. `undo` runs when the user
     * taps the action; the toast then dismisses itself. Pass a
     * `ttlMs` shorter than the default 5s for actions that expire
     * (e.g. ticket close undo is a soft commit — after 6s the change is
     * persisted and undo is no longer possible).
     */
    successWithUndo: (
      message: string,
      undo: () => void | Promise<void>,
      opts: { actionLabel?: string; ttlMs?: number } = {},
    ): ToastItem => {
      const id = store.items.length + 1 // unused — push assigns
      store.push('success', message, {
        actionLabel: opts.actionLabel ?? 'Visszavonás',
        action: undo,
        ttlMs: opts.ttlMs,
      })
      // Return the most recent item so callers can dismiss manually.
      return store.items[store.items.length - 1]!
    },
    dismiss: (id: number) => store.dismiss(id),
  }
}
