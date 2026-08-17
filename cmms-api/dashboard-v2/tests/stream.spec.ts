// tests/stream.spec.ts
//
// Phase 5.2 — Live Stream page tests.
//
// Events are pushed directly into the Pinia stream store — no real
// EventSource is needed. The page's `subscribe()` opens a stubbed
// connection on mount (see tests/setup.ts) which is harmless. `useApi`
// is mocked so the banner submit never hits the network, `vue-router`
// is mocked because `setSeedQ` navigates via `useRouter`, and a
// QueryClient is provided because the page answers via vue-query.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { useStreamStore } from '../src/stores/stream'
import type { AnswerResponse, StreamEvent } from '../src/lib/api'
import StreamPage from '../src/routes/StreamPage.vue'

// ---------------------------------------------------------------------------
// Mocks — hoisted so the module factories can reference them.
// ---------------------------------------------------------------------------

const { answerMock, routerPush } = vi.hoisted(() => ({
  answerMock: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({
    answer: answerMock,
    // The store's subscribe() opens the shared EventSource on mount;
    // return the (stubbed) real thing so the page mounts cleanly.
    stream: () => new EventSource('/dashboard/api/stream'),
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function questionEvent(q: string, t = '2026-08-12T12:00:01.000Z'): StreamEvent {
  return { type: 'question', t, tool: 'answer', q }
}

function approvalEvent(id = 'a1', t = '2026-08-12T12:00:03.000Z'): StreamEvent {
  return { type: 'approval', t, id, action: 'rotate', summary: `APPROVED: ${id}` }
}

const ANSWER_RESPONSE: AnswerResponse = {
  q: 'M26057 vezérlés',
  language: 'hu',
  intent: 'find_ticket',
  primitive: 'search_tickets',
  group_by: null,
  filters: {},
  period: null,
  summary: '1 ticket found for M26057',
  follow_ups: ['open?'],
  results: [],
  evidence: {},
  total: 1,
  rationale: '',
  mode: 'answer',
  confidence: 0.9,
  threshold: 0.6,
  candidates: [],
  mode_rationale: '',
}

function mountPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return mount(StreamPage, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
    },
  })
}

/** Flush vue-query's microtask + macrotask scheduling before asserting. */
async function settle() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamPage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    answerMock.mockReset()
    routerPush.mockReset()
  })

  it('shows the empty state with a typing indicator before any events', () => {
    const wrapper = mountPage()
    const empty = wrapper.get('[data-testid="stream-empty"]')
    expect(empty.text()).toContain('Várakozás a bejövő kérdésekre…')
    // 3 pulsing dots in the typing indicator
    expect(empty.findAll('span.animate-pulse')).toHaveLength(3)
  })

  it('renders a pushed question event as a QUESTION row', async () => {
    const store = useStreamStore()
    store.pushEvent(questionEvent('M26057 vezérlés'))
    const wrapper = mountPage()
    await nextTick()

    const rows = wrapper.findAll('[data-testid="stream-event"]')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.get('[data-testid="event-type"]').text()).toBe('KÉRDÉS')
    expect(row.get('[data-testid="event-body"]').text()).toBe('M26057 vezérlés')
    // Timestamp renders as HH:MM:SS (local time — only assert the shape).
    expect(row.text()).toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(wrapper.get('[data-testid="live-counter"]').text()).toContain('1 esemény')
  })

  it('renders a pushed approval event with disabled Approve/Reject buttons', async () => {
    const store = useStreamStore()
    store.pushEvent(approvalEvent())
    const wrapper = mountPage()
    await nextTick()

    const row = wrapper.get('[data-testid="stream-event"]')
    expect(row.get('[data-testid="event-type"]').text()).toBe('JÓVÁHAGYÁS')
    expect(row.text()).toContain('APPROVED: a1')

    const approve = row.get('[data-testid="approval-approve"]')
    const reject = row.get('[data-testid="approval-reject"]')
    expect((approve.element as HTMLButtonElement).disabled).toBe(true)
    expect((reject.element as HTMLButtonElement).disabled).toBe(true)
    expect(approve.attributes('title')).toBe('A jóváhagyási sor még nincs bekötve')
    expect(reject.attributes('title')).toBe('A jóváhagyási sor még nincs bekötve')
  })

  it('filtering to Approvals hides question events and updates the counter', async () => {
    const store = useStreamStore()
    store.pushEvent(questionEvent('which device?'))
    store.pushEvent(approvalEvent())
    const wrapper = mountPage()
    await nextTick()
    expect(wrapper.findAll('[data-testid="stream-event"]')).toHaveLength(2)

    const approvalsTab = wrapper.findAll('[role="tab"]').find((b) => b.text() === 'Jóváhagyások')
    expect(approvalsTab).toBeDefined()
    await approvalsTab!.trigger('click')
    await nextTick()

    const rows = wrapper.findAll('[data-testid="stream-event"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('APPROVED')
    expect(rows[0]!.text()).not.toContain('which device?')
    expect(wrapper.get('[data-testid="live-counter"]').text()).toContain('1 esemény')
  })

  it('Pause freezes the event list', async () => {
    const store = useStreamStore()
    store.pushEvent(questionEvent('first'))
    const wrapper = mountPage()
    await nextTick()
    expect(wrapper.findAll('[data-testid="stream-event"]')).toHaveLength(1)

    await wrapper.get('[data-testid="stream-pause"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-testid="stream-pause"]').text()).toBe('Folytatás')
    expect(wrapper.get('[data-testid="live-counter"]').text()).toContain('Szünetelve')

    // pushEvent while paused is a no-op — nothing new appears.
    store.pushEvent(questionEvent('second'))
    await nextTick()
    expect(wrapper.findAll('[data-testid="stream-event"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="live-counter"]').text()).toContain('1 esemény')
  })

  it('banner submit calls api.answer and renders the compact answer section', async () => {
    answerMock.mockResolvedValue(ANSWER_RESPONSE)
    const wrapper = mountPage()

    // Hungarian question (non-ASCII) → language 'hu'.
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(answerMock).toHaveBeenCalledWith({ q: 'M26057 vezérlés', language: 'hu' })

    const answer = wrapper.get('[data-testid="stream-answer"]')
    expect(answer.text()).toContain('1 ticket found for M26057')
    expect(answer.text()).toContain('find_ticket')
    expect(answer.text()).toContain('search_tickets')
    expect(wrapper.get('[data-testid="confidence-pill"]').text()).toBe('magas')

    // 'Megnyitás Ask-ban →' carries the submitted question.
    await wrapper.get('[data-testid="show-in-ask"]').trigger('click')
    expect(routerPush).toHaveBeenCalledWith({ path: '/ask', state: { seedQ: 'M26057 vezérlés' } })

    // Follow-up chip re-submits as a new banner question (ASCII → 'en').
    const chip = wrapper.findAll('[data-testid="followup-chip"]').find((b) => b.text() === 'open?')
    expect(chip).toBeDefined()
    await chip!.trigger('click')
    await settle()
    expect(answerMock).toHaveBeenLastCalledWith({ q: 'open?', language: 'en' })
  })

  it('shows the submit chip only when the ask field has text', async () => {
    const wrapper = mountPage()
    // Empty field → no submit control at all.
    expect(wrapper.find('[data-testid="ask-bar-kbd"]').exists()).toBe(false)

    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057')
    expect(wrapper.find('[data-testid="ask-bar-kbd"]').exists()).toBe(true)

    await wrapper.get('[data-testid="ask-bar-input"]').setValue('   ')
    expect(wrapper.find('[data-testid="ask-bar-kbd"]').exists()).toBe(false)
  })
})
