import { useRouter } from 'vue-router'

/**
 * Read & clear the `seedQ` carried on router state.
 * The Ask page calls `consumeSeedQ()` on mount; if a string is returned,
 * the page focuses its input, submits, and we strip the field so a
 * browser back/forward won't re-fire the same seed.
 *
 * Implementation note: vue-router 4 stores `state` on the underlying
 * `history.state` (the browser's history entry), not as a typed field
 * on the route object. So we read/write via `history.state` directly,
 * which is the documented public surface for this in vue-router 4.
 */
type SeedState = { seedQ?: unknown }

function readHistoryState(): SeedState {
  // `history.state` is `any` per lib.dom.d.ts; narrow it.
  const s = (history.state ?? {}) as Record<string, unknown>
  const usr = (s.usr ?? {}) as SeedState
  return usr
}

export function consumeSeedQ(): string | null {
  const router = useRouter()
  const usr = readHistoryState()
  const seedQ = usr.seedQ
  if (typeof seedQ !== 'string' || seedQ.length === 0) {
    return null
  }
  // Replace history state with a clean copy so seedQ doesn't re-fire
  // on a back/forward navigation.
  const clean: SeedState = { ...usr }
  delete clean.seedQ
  const next = { ...(history.state as Record<string, unknown>), usr: clean }
  history.replaceState(next, '', router.currentRoute.value.fullPath)
  return seedQ
}

export function setSeedQ(q: string): void {
  const router = useRouter()
  // vue-router 4's push signature is `push(to, locationAsRelativeRaw?)`.
  // `state` is not a typed field on that arg; it gets passed through to
  // history.state under the hood. We cast to `any` at the boundary.
  router.push({ path: '/ask', state: { seedQ: q } } as never)
}
