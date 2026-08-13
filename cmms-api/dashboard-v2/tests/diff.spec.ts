// tests/diff.spec.ts
//
// Phase 5.4 — DiffPage.vue (/dashboard/diff).
//
// Mounts the page with vue-query (retry disabled) and a mocked
// `useApi().diff` so each test controls resolution. Covers the submit
// model (preset chip + manual picker), the change-list rendering, the
// "View ticket →" seed, and the empty / error / retry states.
//
// Run: cd cmms-api/dashboard-v2 && bun run test (vitest)

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia, setActivePinia } from 'pinia'
import type { Pinia } from 'pinia'
import DiffPage from '../src/routes/DiffPage.vue'
import { ALL_TIME_ISO, isoToPickerValue } from '../src/lib/diff'
import type { DiffChange } from '../src/lib/api'

// ---------------------------------------------------------------------------
// Mocks — api.diff (resolution control) + vue-router useRouter (setSeedQ).
// ---------------------------------------------------------------------------

const { diffMock, pushMock } = vi.hoisted(() => ({
  diffMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ diff: diffMock }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANGES: DiffChange[] = [
  {
    entity: 'answer',
    id: 'M-2026/0123',
    action: 'answer',
    t: '2026-08-12T14:30:22.000Z',
    before: null,
    after: 'Vezérlő hiba javítva — PLC újraprogramozva',
  },
  {
    entity: 'approval',
    id: 'M-2026/0456',
    action: 'approval',
    t: '2026-08-12T13:00:00.000Z',
    before: null,
    after: 'Jóváhagyva: token rotáció',
  },
]

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let pinia: Pinia
let queryClient: QueryClient

async function settle() {
  await flushPromises()
  await nextTick()
}

function mountPage() {
  return mount(DiffPage, {
    global: {
      plugins: [
        pinia,
        [VueQueryPlugin, { queryClient }],
      ],
    },
  })
}

describe('DiffPage', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    diffMock.mockReset()
    pushMock.mockReset()
  })

  it('24h preset submits ~now-24h and syncs the picker input', async () => {
    diffMock.mockResolvedValueOnce({ changes: [] })
    const wrapper = mountPage()
    // Nothing runs until the operator submits.
    expect(diffMock).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="preset-24h"]').trigger('click')
    await settle()

    expect(diffMock).toHaveBeenCalledTimes(1)
    const sinceArg = diffMock.mock.calls[0]![0] as string
    // Allowed drift: the preset computes `now` at click time.
    const expected = Date.now() - 86_400_000
    expect(Math.abs(Date.parse(sinceArg) - expected)).toBeLessThan(3_600_000)
    // The picker input is synced to the same window.
    const input = wrapper.get('[data-testid="since-input"]').element as HTMLInputElement
    expect(input.value).toBe(isoToPickerValue(sinceArg))
  })

  it('renders one card per change with after text, action badges, and timestamps', async () => {
    diffMock.mockResolvedValueOnce({ changes: CHANGES })
    const wrapper = mountPage()
    await wrapper.get('[data-testid="preset-24h"]').trigger('click')
    await settle()

    const entries = wrapper.findAll('[data-testid="diff-entry"]')
    expect(entries).toHaveLength(2)

    const bodies = wrapper.findAll('[data-testid="diff-block-pre"]')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.text()).toContain('Vezérlő hiba javítva')
    expect(bodies[1]!.text()).toContain('Jóváhagyva: token rotáció')

    const badges = wrapper.findAll('[data-testid="diff-action-badge"]')
    expect(badges[0]!.text()).toBe('answer')
    expect(badges[1]!.text()).toBe('approval')

    expect(entries[0]!.text()).toContain('2026-08-12 14:30:22')
    expect(entries[0]!.text()).toContain('M-2026/0123')
  })

  it('View ticket seeds the Ask page with "ticket <id>"', async () => {
    diffMock.mockResolvedValueOnce({ changes: CHANGES })
    const wrapper = mountPage()
    await wrapper.get('[data-testid="preset-24h"]').trigger('click')
    await settle()

    await wrapper.findAll('[data-testid="view-ticket"]')[0]!.trigger('click')

    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/ask',
        state: expect.objectContaining({ seedQ: 'ticket M-2026/0123' }),
      }),
    )
  })

  it('empty changes render the EmptyState; "Broaden the time range" fetches all time', async () => {
    diffMock.mockResolvedValueOnce({ changes: [] })
    const wrapper = mountPage()
    await wrapper.get('[data-testid="preset-24h"]').trigger('click')
    await settle()

    const empty = wrapper.get('[data-testid="empty-state"]')
    expect(empty.text()).toContain('Nincs változás ebben az ablakban')
    expect(empty.text()).toContain('A kiválasztott idt kezdve nem volt jóváhagyás vagy answer esemény.')

    diffMock.mockResolvedValueOnce({ changes: [] })
    await wrapper.get('[data-testid="broaden-range"]').trigger('click')
    await settle()

    expect(diffMock).toHaveBeenLastCalledWith(ALL_TIME_ISO)
  })

  it('a rejected diff renders the ErrorState; Retry refetches and recovers', async () => {
    diffMock.mockRejectedValueOnce({
      status: 404,
      message: 'HTTP 404',
      body: { error: 'not found' },
    })
    const wrapper = mountPage()
    await wrapper.get('[data-testid="preset-24h"]').trigger('click')
    await settle()

    const errorState = wrapper.get('[data-testid="error-state"]')
    expect(errorState.text()).toContain('A kérés elbukott (HTTP 404)')
    expect(errorState.text()).toContain('not found')

    diffMock.mockResolvedValueOnce({ changes: [CHANGES[0]!] })
    await wrapper.get('[data-testid="error-state-retry"]').trigger('click')
    await settle()

    expect(diffMock).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="diff-entry"]')).toHaveLength(1)
  })

  it('Load diff submits the manual picker value as UTC ISO', async () => {
    diffMock.mockResolvedValueOnce({ changes: [] })
    const wrapper = mountPage()

    await wrapper.get('[data-testid="since-input"]').setValue('2026-08-12T14:30')
    await wrapper.get('[data-testid="load-diff"]').trigger('click')
    await settle()

    expect(diffMock).toHaveBeenCalledTimes(1)
    expect(diffMock).toHaveBeenCalledWith('2026-08-12T14:30:00.000Z')
  })
})
