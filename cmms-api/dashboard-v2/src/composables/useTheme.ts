// src/composables/useTheme.ts
//
// Light / dark theme state. The actual visual switch is driven by
// a `.dark` class on <html>, which is bound to the CSS variables
// in styles/tokens.css. This composable:
//   - reads the user's saved preference (or system default) on mount
//   - exposes a `theme` ref + `toggle()` so the ThemeToggle can flip
//   - applies the .dark class to <html> reactively
//   - persists the choice in localStorage so reloads remember it
//
// Why this lives in a composable (not a Pinia store): theme is a
// per-tab UI state, not an app state. Two tabs open simultaneously
// can have different themes. localStorage is shared, so a sync
// listener picks up external changes (rare, but useful for the
// "user has two windows open" case).

import { onBeforeUnmount, ref, watch } from 'vue'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'cmms_theme'

function readInitial(): Theme {
  if (typeof localStorage === 'undefined') return 'dark'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  // Fall back to the OS preference, then to dark (the original look).
  if (typeof window !== 'undefined' && window.matchMedia) {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  }
  return 'dark'
}

const theme = ref<Theme>(readInitial())

function applyToDocument(t: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (t === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

// Apply once at import time so the very first paint uses the right
// palette (no flash of the wrong theme).
applyToDocument(theme.value)

watch(theme, (t) => {
  applyToDocument(t)
  try {
    localStorage.setItem(STORAGE_KEY, t)
  } catch {
    // ignore (private mode, etc.)
  }
})

// Cross-tab sync: when the user flips the theme in another tab, we
// pick it up here too. Cheap event, no debounce needed.
let storageListener: ((e: StorageEvent) => void) | null = null
if (typeof window !== 'undefined') {
  storageListener = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return
    const next = e.newValue
    if (next === 'light' || next === 'dark') theme.value = next
  }
  window.addEventListener('storage', storageListener)
  onBeforeUnmount(() => {
    if (storageListener) window.removeEventListener('storage', storageListener)
  })
}

export function useTheme() {
  return {
    theme,
    isDark: () => theme.value === 'dark',
    toggle: () => {
      theme.value = theme.value === 'dark' ? 'light' : 'dark'
    },
    set: (t: Theme) => {
      theme.value = t
    },
  }
}
