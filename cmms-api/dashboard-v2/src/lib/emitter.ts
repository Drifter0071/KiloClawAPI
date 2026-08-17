type Handler = (...args: any[]) => void
const map = new Map<string, Set<Handler>>()
export const emitter = {
  on(event: string, fn: Handler) {
    const set = map.get(event) ?? map.set(event, new Set()).get(event)!
    set.add(fn)
    return () => map.get(event)!.delete(fn)
  },
  emit(event: string, ...args: any[]) {
    map.get(event)?.forEach(fn => fn(...args))
  },
}
