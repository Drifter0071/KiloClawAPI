import { useRouter } from 'vue-router'
import { emitter } from '../lib/emitter'

const ROUTE_BY_KEY: Record<string, string> = {
  a: '/ask',
  s: '/stream',
  m: '/map',
  d: '/diff',
  t: '/tokens',
}

const G_CHORD_TIMEOUT_MS = 1500

let installed = false
let pendingGTimeout: ReturnType<typeof setTimeout> | null = null

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

function clearPendingG() {
  if (pendingGTimeout !== null) {
    clearTimeout(pendingGTimeout)
    pendingGTimeout = null
  }
}

function handleKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const typing = isTypingTarget(target)

  // Esc always works, even when typing.
  if (e.key === 'Escape') {
    emitter.emit('escape')
    return
  }

  if (typing) return

  // Ignore any other shortcut when a modifier is held (we want Ctrl/Cmd
  // only for the explicit Cmd/Ctrl+K path below).
  if (e.metaKey || e.ctrlKey || e.altKey) {
    // Cmd/Ctrl+K → focus the Ask input (or navigate to it).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      const askInput = document.getElementById('ask-input') as HTMLInputElement | HTMLTextAreaElement | null
      const router = useRouter()
      if (askInput) {
        askInput.focus()
        if (askInput instanceof HTMLInputElement) askInput.select()
      } else {
        router.push('/ask')
      }
    }
    return
  }

  // ? (Shift+/) → open the keyboard shortcut modal.
  if (e.key === '?') {
    e.preventDefault()
    emitter.emit('open-shortcut-modal')
    return
  }

  // Plain `g` starts a 1500ms chord window.
  if (e.key === 'g') {
    clearPendingG()
    pendingGTimeout = setTimeout(() => {
      pendingGTimeout = null
    }, G_CHORD_TIMEOUT_MS)
    return
  }

  // Letter after `g` → route jump.
  if (pendingGTimeout !== null) {
    const route = ROUTE_BY_KEY[e.key.toLowerCase()]
    clearPendingG()
    if (route) {
      e.preventDefault()
      const router = useRouter()
      router.push(route)
    }
  }
}

export function useKeyboardShortcuts(): void {
  if (installed) return
  if (typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', handleKeydown)
}
