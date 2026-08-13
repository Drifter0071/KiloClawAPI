// tests/map.spec.ts
//
// Phase 5.3 — MapPage.vue (/dashboard/map).
//
// Mocks @/lib/cytoscape's makeCyto (cytoscape can't run under happy-dom)
// and captures the node tap/hover callbacks so tests can simulate graph
// interaction. Covers: auto-fetch with default period, period switch
// (auto-submit), node click → drawer with samples, "View all in Ask →"
// seed, loading overlay, error + retry, empty state + broaden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { nextTick } from 'vue'
import MapPage from '../src/routes/MapPage.vue'
import type { MapNode, MapResponse } from '../src/lib/api'

// ---------------------------------------------------------------------------
// Mocks — map fetch + cytoscape (captures interaction callbacks)
// ---------------------------------------------------------------------------

const { mapMock, pushMock, makeCytoMock } = vi.hoisted(() => ({
  mapMock: vi.fn(),
  pushMock: vi.fn(),
  makeCytoMock: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ map: mapMock }),
}))

vi.mock('@/lib/cytoscape', () => ({
  makeCyto: makeCytoMock,
  // nodeSize is imported by MapPage for the legend swatches; the
  // production module exports it but the test mock only needs a
  // pure JS implementation — cytoscape never runs in this test.
  nodeSize: (t: number) => 16 + Math.round(Math.sqrt(Math.max(0, t ?? 0)) * 4.2),
  shortLabel: (s: string) => s,
  nodeColor: () => 'hsl(0, 70%, 62%)',
  nodeHue: () => 0,
  computeEdges: () => [],
  // v6 additions — used by MapPage's filter / hover. The test
  // fixture already uses real machine labels, so isMachineLabel
  // returns true and filterMachineNodes is a no-op identity.
  familyKey: (s: string) => s,
  isMachineLabel: () => true,
  filterMachineNodes: <T,>(nodes: T[]) => ({ kept: nodes, dropped: [] as T[] }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

// The mock returns a fake cy instance and stashes the tap/hover callbacks
// so tests can drive graph interaction directly.
const cyStub = {
  destroy: vi.fn(),
}
let lastOnTap: ((n: MapNode) => void) | null = null
let lastOnHover: ((n: MapNode, evt: MouseEvent) => void) | null = null

makeCytoMock.mockImplementation(
  (_el: HTMLElement, _nodes: MapNode[], onTap?: (n: MapNode) => void, onHover?: (n: MapNode, evt: MouseEvent) => void) => {
    lastOnTap = onTap ?? null
    lastOnHover = onHover ?? null
    return cyStub
  },
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NODES: MapNode[] = [
  {
    model: 'M26057',
    raw: 'M26057',
    tickets: 12,
    samples: [
      {
        sorszam: 'M-2026/0123',
        snippet: 'Vezérlő hiba, PLC újraprogramozva',
        kategoria: 'Szoftver hiba',
        kategoria_inferred: null,
        sulyossag_inferred: 'kozepes',
      },
      {
        sorszam: 'M-2026/0456',
        snippet: 'Kijelző nem világít',
        kategoria: 'Kijelzo hiba',
        kategoria_inferred: null,
        sulyossag_inferred: 'alacsony',
      },
    ],
  },
  { model: 'iPS', raw: 'iPS', tickets: 2, samples: [] },
]

function mapResponse(overrides: Partial<MapResponse> = {}): MapResponse {
  return { nodes: NODES, total_groups: 2, period: null, ...overrides }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let wrapper: VueWrapper | null = null

function mountPage(): VueWrapper {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  wrapper = mount(MapPage, {
    global: {
      plugins: [pinia, [VueQueryPlugin, { queryClient }]],
    },
  })
  return wrapper
}

/** The Drawer renders via Teleport → content lives in document.body. */
function bodyPanel(): Element | null {
  return document.body.querySelector('[data-testid="drawer-panel"]')
}

beforeEach(() => {
  mapMock.mockReset()
  pushMock.mockReset()
  makeCytoMock.mockClear()
  cyStub.destroy.mockClear()
  lastOnTap = null
  lastOnHover = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MapPage', () => {
  it('auto-fetches with the default period and renders the graph', async () => {
    mapMock.mockResolvedValueOnce(mapResponse())
    const w = mountPage()
    await flushPromises()
    await nextTick()

    expect(mapMock).toHaveBeenCalledTimes(1)
    expect(mapMock).toHaveBeenCalledWith('this_month')
    expect(makeCytoMock).toHaveBeenCalledTimes(1)
    const nodesArg = makeCytoMock.mock.calls[0]![1] as MapNode[]
    expect(nodesArg).toHaveLength(2)
    expect(w.find('[data-testid="map-loading"]').exists()).toBe(false)
    expect(w.find('[data-testid="map-error"]').exists()).toBe(false)
  })

  it('switching the period auto-submits and rebuilds the graph', async () => {
    mapMock.mockResolvedValueOnce(mapResponse())
    const w = mountPage()
    await flushPromises()
    await nextTick()

    mapMock.mockResolvedValueOnce(mapResponse({ nodes: [NODES[0]!], total_groups: 1 }))
    await w.findAll('button').find((b) => b.text() === 'Tavaly')!.trigger('click')
    await flushPromises()
    await nextTick()

    expect(mapMock).toHaveBeenLastCalledWith('last_year')
    // Old graph destroyed, new graph built from the fresh data.
    expect(cyStub.destroy).toHaveBeenCalled()
    expect(makeCytoMock).toHaveBeenCalledTimes(2)
    const nodesArg = makeCytoMock.mock.calls[1]![1] as MapNode[]
    expect(nodesArg).toHaveLength(1)
  })

  it('node tap opens the side sheet with top sample tickets', async () => {
    mapMock.mockResolvedValueOnce(mapResponse())
    const w = mountPage()
    await flushPromises()
    await nextTick()

    expect(bodyPanel()).toBeNull()
    lastOnTap?.(NODES[0]!)
    await nextTick()

    const panel = bodyPanel()
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('M26057')
    expect(panel!.textContent).toContain('12 ticket')
    const samples = panel!.querySelectorAll('[data-testid="map-sample"]')
    expect(samples).toHaveLength(2)
    expect(panel!.textContent).toContain('M-2026/0123')
  })

  it('"View all in Ask →" seeds the Ask page with the model', async () => {
    mapMock.mockResolvedValueOnce(mapResponse())
    const w = mountPage()
    await flushPromises()
    await nextTick()

    lastOnTap?.(NODES[0]!)
    await nextTick()
    await bodyPanel()!.querySelector<HTMLButtonElement>('[data-testid="map-view-all"]')!.click()
    await nextTick()

    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/ask',
        state: expect.objectContaining({ seedQ: 'M26057' }),
      }),
    )
  })

  it('hover shows the floating tooltip; mouseleave hides it', async () => {
    mapMock.mockResolvedValueOnce(mapResponse())
    const w = mountPage()
    await flushPromises()
    await nextTick()

    expect(w.find('[data-testid="map-tooltip"]').exists()).toBe(false)
    lastOnHover?.(NODES[0]!, { clientX: 100, clientY: 200 } as MouseEvent)
    await nextTick()

    const tip = w.get('[data-testid="map-tooltip"]')
    expect(tip.text()).toContain('M26057')
    expect(tip.text()).toContain('12 ticket')

    await w.get('[data-testid="map-canvas"]').trigger('mouseleave')
    await nextTick()
    expect(w.find('[data-testid="map-tooltip"]').exists()).toBe(false)
  })

  it('shows the loading overlay while the first fetch is pending', async () => {
    let resolveMap: (v: MapResponse) => void = () => {}
    mapMock.mockReturnValueOnce(new Promise((res) => { resolveMap = res }))
    const w = mountPage()
    await nextTick()

    expect(w.get('[data-testid="map-loading"]').exists()).toBe(true)

    resolveMap(mapResponse())
    await flushPromises()
    await nextTick()
    expect(w.find('[data-testid="map-loading"]').exists()).toBe(false)
  })

  it('a failed fetch renders the error overlay; Retry refetches and recovers', async () => {
    mapMock.mockRejectedValueOnce({
      status: 503,
      message: 'HTTP 503',
      body: { error: 'cmms-api unavailable', detail: 'reloading after deploy' },
    })
    const w = mountPage()
    await flushPromises()
    await nextTick()

    const err = w.get('[data-testid="map-error"]')
    expect(err.text()).toContain('CMMS API nem elérhet')
    expect(err.text()).toContain('reloading after deploy')

    mapMock.mockResolvedValueOnce(mapResponse())
    await w.get('[data-testid="map-error-retry"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(mapMock).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="map-error"]').exists()).toBe(false)
    expect(makeCytoMock).toHaveBeenCalledTimes(1)
  })

  it('empty nodes render the empty state; Broaden switches to all-time', async () => {
    mapMock.mockResolvedValueOnce(mapResponse({ nodes: [], total_groups: 0 }))
    const w = mountPage()
    await flushPromises()
    await nextTick()

    expect(w.get('[data-testid="map-empty"]').text()).toContain('Nincs adat ebben az idszakban')

    mapMock.mockResolvedValueOnce(mapResponse())
    await w.get('[data-testid="map-broaden"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(mapMock).toHaveBeenLastCalledWith('all')
    expect(w.find('[data-testid="map-empty"]').exists()).toBe(false)
  })

  it('refresh button refetches the current period', async () => {
    mapMock.mockResolvedValueOnce(mapResponse())
    const w = mountPage()
    await flushPromises()
    await nextTick()

    mapMock.mockResolvedValueOnce(mapResponse())
    await w.get('[data-testid="map-refresh"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect(mapMock).toHaveBeenCalledTimes(2)
    expect(mapMock).toHaveBeenLastCalledWith('this_month')
  })
})
