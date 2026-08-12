// src/composables/useToast.ts
//
// Tiny composable that wraps the toast Pinia store with ergonomic
// variants. Importable as `import { useToast } from '@/composables/useToast'`.
//
// The Toast container component (src/components/Toast.vue) reads the
// same store; the composable is the only thing consumers use to push
// new toasts. Items auto-dismiss after TOAST_TTL_MS (5s) on the store
// side, and can also be dismissed manually via `dismiss(id)`.

import { useToastStore } from '@/stores/toast'

export function useToast() {
  const store = useToastStore()
  return {
    error: (msg: string) => store.push('error', msg),
    warn: (msg: string) => store.push('warning', msg),
    info: (msg: string) => store.push('info', msg),
    dismiss: (id: number) => store.dismiss(id),
  }
}
