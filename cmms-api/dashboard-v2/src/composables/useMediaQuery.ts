import { ref, onMounted, onUnmounted, type Ref } from 'vue'

/**
 * Reactive `window.matchMedia(query)` wrapper.
 * Returns a Ref<boolean> that updates on the mql `change` event.
 * SSR-safe: returns ref(false) if `window` is undefined.
 */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false)

  if (typeof window === 'undefined' || !window.matchMedia) {
    return matches
  }

  let mql: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => {
    matches.value = e.matches
  }

  onMounted(() => {
    mql = window.matchMedia(query)
    matches.value = mql.matches
    mql.addEventListener('change', onChange)
  })

  onUnmounted(() => {
    mql?.removeEventListener('change', onChange)
    mql = null
  })

  return matches
}
