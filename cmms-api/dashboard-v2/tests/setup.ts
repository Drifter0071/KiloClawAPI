// tests/setup.ts
//
// Vitest setup file. Runs before every test file (configured in
// vitest.config.ts under `test.setupFiles`). Installs a minimal
// `EventSource` global so the stream store / useEventSource tests
// don't crash on `new EventSource(...)` — happy-dom doesn't ship one
// and our manager's `useApi().stream()` calls the constructor
// unconditionally. The stub also captures the URL and init for tests
// that want to assert on it.
//
// We don't use real EventSource connections in tests — there's no
// server to connect to. The stream store is tested via direct
// `pushEvent()` calls, which bypass the EventSource entirely.

class StubEventSource {
  url: string
  init: { withCredentials?: boolean } | undefined
  readyState: number = 0 // CONNECTING
  onopen: ((ev?: Event) => void) | null = null
  onerror: ((ev?: Event) => void) | null = null
  onmessage: ((ev?: MessageEvent) => void) | null = null
  private listeners = new Map<string, Set<EventListener>>()

  constructor(url: string, init?: EventSourceInit) {
    this.url = url
    this.init = init
  }
  addEventListener(type: string, listener: EventListener) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }
  dispatchEvent(event: Event): boolean {
    const set = this.listeners.get(event.type)
    if (set) for (const fn of set) fn(event)
    return true
  }
  close() {
    this.readyState = 2 // CLOSED
  }
}

// @ts-expect-error — happy-dom doesn't ship EventSource; we provide a stub.
globalThis.EventSource = StubEventSource
