// tests/disliked-answers-page.spec.ts
//
// DislikedAnswersPage (src/routes/DislikedAnswersPage.vue) — admin
// master/detail view. Two pieces of behavior covered here:
//
//   1. The list row shows a "✓ N javaslat" badge when the row's
//      `correction_count > 0`. Rows without a follow-up correction
//      stay unbadged.
//   2. The detail drawer shows the operator's proposed correct
//      answer above the agent's "Végső válasz" — full text + short
//      uid + timestamp, with a multi-proposer pill when more than
//      one uid submitted. Drawer items with no correction hide the
//      block entirely.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import DislikedAnswersPage from '../src/routes/DislikedAnswersPage.vue'
import type { DislikedListResponse, DislikedItem } from '../src/composables/useAdminFeedback'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function item(overrides: Partial<DislikedItem> = {}): DislikedItem {
  return {
    answer_id: '01HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    q: 'M26057 vezérlés?',
    final_text: 'A vezérlő NCTNCT 4 firmware-t használ.',
    tool_trace: [
      { name: 'answer_question', args: { q: 'M26057 vezérlés?' }, ok: true },
    ],
    model: 'openai/gpt-5.6-luna-pro',
    iterations: 2,
    language: 'hu',
    resolved_customer: 'ANDRITZ KFT.',
    ticket_cards: [
      { sorszam: 'B2408001', customer_name: 'ANDRITZ KFT.', snippet: 'Vezérlő hiba' },
    ],
    created_at: '2026-08-19T12:00:00.000Z',
    vote: {
      uid: '11111111-2222-3333-4444-555555555555',
      vote: -1,
      reason: 'wrong data (number/date/count)',
      created_at: '2026-08-19T12:05:00.000Z',
    },
    correction: null,
    correction_count: 0,
    ...overrides,
  }
}

function makeResponse(items: DislikedItem[]): DislikedListResponse {
  return { items, total: items.length, limit: 50, offset: 0 }
}

const NO_ROW = '01HNOOOOOOOOOOOOOOOOOOOOOOOOOO'
const ONE_ROW = '01HONECORRECTIONAAAAAAAAAAAAAAA'
const MULTI_ROW = '01HMULTIPLECORRECTIONSBBBBBBBBB'

const SAMPLE_ITEMS: DislikedItem[] = [
  item({
    answer_id: NO_ROW,
    q: 'Nincs javítás',
    correction: null,
    correction_count: 0,
  }),
  item({
    answer_id: ONE_ROW,
    q: 'Egy javítás',
    vote: {
      uid: '11111111-2222-3333-4444-555555555555',
      vote: -1,
      reason: 'missed relevant ticket(s)',
      created_at: '2026-08-19T12:10:00.000Z',
    },
    correction: {
      uid: '11111111-2222-3333-4444-555555555555',
      correction: 'A helyes válasz B2408001-re mutat, nem B2407001-re.',
      created_at: '2026-08-19T12:11:00.000Z',
    },
    correction_count: 1,
  }),
  item({
    answer_id: MULTI_ROW,
    q: 'Több javítás',
    vote: {
      uid: '22222222-3333-4444-5555-666666666666',
      vote: -1,
      reason: 'made something up',
      created_at: '2026-08-19T12:20:00.000Z',
    },
    correction: {
      uid: '33333333-4444-5555-6666-777777777777',
      correction: 'Második, legfrissebb javaslat — a B-sorszám B2408001.',
      created_at: '2026-08-19T12:22:00.000Z',
    },
    correction_count: 2,
  }),
]

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loadDislikedMock } = vi.hoisted(() => ({ loadDislikedMock: vi.fn() }))

vi.mock('@/composables/useAdminFeedback', () => ({
  useAdminFeedback: () => ({ loadDisliked: loadDislikedMock }),
  AdminAuthError: class AdminAuthError extends Error {
    constructor() { super('admin_not_authenticated') }
  },
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn() }),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/panel', component: { template: '<div/>' } },
    ],
  })
  // The detail drawer is teleported to <body>, so we need the wrapper
  // attached to document.body for `wrapper.find()` to see the drawer
  // markup. Otherwise we'd have to use document.body.querySelector
  // for every assertion (and the wrapper would be detached from
  // the DOM, so trigger() events on inner elements wouldn't bubble).
  return mount(DislikedAnswersPage, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  })
}

beforeEach(() => {
  loadDislikedMock.mockReset()
  vi.unstubAllGlobals()
  // Body overflow is mutated by lockBodyScroll; reset between tests.
  document.body.style.overflow = ''
  // The detail drawer is teleported to <body> and the wrapper is
  // attached to <body>, so leftover drawer markup from a previous
  // test can pollute document.body.querySelector results. Wipe any
  // leftover teleported drawer (the testid only appears inside the
  // drawer's DOM subtree).
  document.body.querySelectorAll('[data-testid="disliked-answers-drawer"], [data-testid="disliked-answers-backdrop"]').forEach((el) => el.remove())
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DislikedAnswersPage — list row badges', () => {
  it('shows a "1 javaslat" badge for rows with one correction', async () => {
    loadDislikedMock.mockResolvedValueOnce(makeResponse(SAMPLE_ITEMS))
    const wrapper = mountPage()
    await flushPromises()
    const badge = wrapper.find(`[data-testid="disliked-answers-correction-badge-${ONE_ROW}"]`)
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('1 javaslat')
  })

  it('shows a "N javaslat" badge for rows with multiple corrections', async () => {
    loadDislikedMock.mockResolvedValueOnce(makeResponse(SAMPLE_ITEMS))
    const wrapper = mountPage()
    await flushPromises()
    const badge = wrapper.find(`[data-testid="disliked-answers-correction-badge-${MULTI_ROW}"]`)
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('2 javaslat')
  })

  it('does NOT show a badge for rows with no correction', async () => {
    loadDislikedMock.mockResolvedValueOnce(makeResponse(SAMPLE_ITEMS))
    const wrapper = mountPage()
    await flushPromises()
    const badge = wrapper.find(`[data-testid="disliked-answers-correction-badge-${NO_ROW}"]`)
    expect(badge.exists()).toBe(false)
  })
})

describe('DislikedAnswersPage — drawer correction block', () => {
  async function openRow(wrapper: ReturnType<typeof mountPage>, answerId: string): Promise<void> {
    await wrapper.get(`[data-testid="disliked-answers-row-${answerId}"]`).trigger('click')
    // Two ticks: the first for the click handler's reactivity flush
    // (selectedId ref → selected computed → v-if); the second for the
    // <Transition> enter classes to commit. flushPromises alone
    // doesn't always cover the transition setup.
    await nextTick()
    await nextTick()
    await flushPromises()
  }

  // The detail drawer is wrapped in <Teleport to="body">, so
  // wrapper.find() can't reach it (vue-test-utils scopes queries to
  // the wrapper's element subtree; teleported children land directly
  // in document.body). Reach into the document for the drawer markup.
  function drawer(sel: string): Element | null {
    return document.body.querySelector(sel)
  }

  it('renders the proposed correct answer for rows with a correction', async () => {
    loadDislikedMock.mockResolvedValueOnce(makeResponse(SAMPLE_ITEMS))
    const wrapper = mountPage()
    await flushPromises()
    await openRow(wrapper, ONE_ROW)

    // The block is rendered with the proposed correct answer text.
    expect(drawer('[data-testid="disliked-answers-drawer-correction"]')).not.toBeNull()
    expect(drawer(`[data-testid="disliked-answers-drawer-correction-text-${ONE_ROW}"]`)!.textContent)
      .toBe('A helyes válasz B2408001-re mutat, nem B2407001-re.')
    // The short uid (first 8 chars) is shown, not the full UUID.
    expect(drawer(`[data-testid="disliked-answers-drawer-correction-uid-${ONE_ROW}"]`)!.textContent)
      .toBe('11111111')
    // Single-proposer rows do NOT show the "N javaslat" pill.
    expect(
      drawer(`[data-testid="disliked-answers-drawer-correction-count-${ONE_ROW}"]`)
    ).toBeNull()
  })

  it('shows the multi-proposer pill when more than one uid contributed', async () => {
    loadDislikedMock.mockResolvedValueOnce(makeResponse(SAMPLE_ITEMS))
    const wrapper = mountPage()
    await flushPromises()
    await openRow(wrapper, MULTI_ROW)
    expect(drawer('[data-testid="disliked-answers-drawer-correction"]')).not.toBeNull()
    expect(
      drawer(`[data-testid="disliked-answers-drawer-correction-count-${MULTI_ROW}"]`)
    ).not.toBeNull()
    expect(
      drawer(`[data-testid="disliked-answers-drawer-correction-count-${MULTI_ROW}"]`)!.textContent
    ).toContain('2 javaslat')
  })

  it('hides the block entirely for rows with no correction', async () => {
    loadDislikedMock.mockResolvedValueOnce(makeResponse(SAMPLE_ITEMS))
    const wrapper = mountPage()
    await flushPromises()
    await openRow(wrapper, NO_ROW)
    // No correction block should be rendered.
    expect(drawer('[data-testid="disliked-answers-drawer-correction"]')).toBeNull()
    // The "Végső válasz" block is still rendered, confirming the row
    // IS selected (the test isn't accidentally testing the wrong row).
    expect(drawer('[data-testid="disliked-answers-drawer-final"]')).not.toBeNull()
  })
})
