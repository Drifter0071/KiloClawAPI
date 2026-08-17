// tests/ask.spec.ts
//
// AskPage (src/routes/AskPage.vue) — AGENTIC path (2026-08-13 pivot:
// gpt-4o picks and calls the tools itself, always on; "goodbye to the
// current system").
// Covers: empty state, submit flow, AgentBody rendering (final_text +
// tool-trace chips + meta), pulsing AI icon while busy, error + retry,
// per-client thread split via resolved_customer, legacy AnswerBody
// rendering of stored history (meta.answer).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AskPage from '../src/routes/AskPage.vue'
import { useAskStore } from '../src/stores/ask'
import type { AnswerAgentResponse, AnswerResponse } from '../src/lib/api'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { agentMock } = vi.hoisted(() => ({ agentMock: vi.fn() }))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ answerAgent: agentMock }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { fullPath: '/ask' } } }),
}))

function sampleAgent(overrides: Partial<AnswerAgentResponse> = {}): AnswerAgentResponse {
  return {
    final_text: 'Az M26057 vezérlése: NCTNCT 4. (forrás: B26071801, PLASMA-TECH SYSTEMS KFT.)',
    tool_trace: [
      { name: 'answer_question', args: { q: 'M26057 vezérlés' }, ok: true },
      { name: 'search_tickets', args: { device: 'M26057' }, ok: true },
    ],
    iterations: 2,
    model: 'openai/gpt-4o-mini',
    resolved_customer: null,
    language: 'hu',
    ...overrides,
  }
}

function sampleAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    q: 'M26057 vezérlés',
    language: 'hu',
    intent: 'find_ticket',
    primitive: 'search_tickets',
    group_by: null,
    filters: {},
    period: null,
    summary: '1 ticket található',
    follow_ups: ['Show customer', 'Top ügyfelek tavaly'],
    results: [{ sorszam: 'M-2026/0123', snippet: 'Vezérlő hiba, PLC', kategoria: 'Szoftver hiba' }],
    evidence: {
      'M-2026/0123': [
        {
          sorszam: 'M-2026/0123',
          key: 'a',
          reported_at_iso: '2026-08-01T10:00:00Z',
          snippet: 'Vezérlő hiba, PLC',
          kategoria: 'Szoftver hiba',
          kategoria_inferred: null,
          sulyossag_inferred: 'kozepes',
        },
      ],
    },
    total: 1,
    rationale: 'keyword match',
    mode: 'answer',
    confidence: 0.92,
    threshold: 0.6,
    candidates: [
      {
        rank: 1,
        intent: 'find_ticket',
        primitive: 'search_tickets',
        score: 0.92,
        score_breakdown: {},
        family: 'other',
        filters: {},
        period: null,
        summary: '1 ticket található',
        follow_ups: [],
        results: [],
        evidence: {},
        total: 1,
        rationale: '',
      },
    ],
    mode_rationale: '',
    ...overrides,
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function mountAskPage(pinia?: Pinia) {
  const active = pinia ?? createPinia()
  return mount(AskPage, {
    global: {
      plugins: [active, [VueQueryPlugin, { queryClient }]],
    },
  })
}

describe('AskPage (agentic)', () => {
  beforeEach(() => {
    agentMock.mockReset()
    // The ask store persists per-client threads to localStorage; vitest
    // reuses the happy-dom window across tests in this file, so each
    // test must start from a clean slate or messages accumulate.
    localStorage.clear()
    // The QueryClient is module-level and caches by queryKey — a later
    // test reusing the same key (same question + run counter) would
    // otherwise get the previous test's cached answer synchronously and
    // never show the pending state / error path.
    queryClient.clear()
  })

  it('renders the hero empty state with example chips and a random greeting', () => {
    const wrapper = mountAskPage()
    expect(wrapper.find('[data-testid="ask-empty"]').exists()).toBe(true)
    const greeting = wrapper.get('[data-testid="ask-greeting"]')
    expect(greeting.text().length).toBeGreaterThan(8)
    expect(greeting.text().endsWith('.') || greeting.text().endsWith('?')).toBe(true)
    expect(wrapper.findAll('[data-testid="example-chip"]').length).toBe(4)
  })

  it('submits via answerAgent and renders the agentic answer', async () => {
    agentMock.mockResolvedValueOnce(sampleAgent())
    const wrapper = mountAskPage()
    const input = wrapper.get('[data-testid="ask-bar-input"]')
    await input.setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    // user bubble pushed synchronously
    expect(wrapper.findAll('[data-testid="user-message"]').length).toBe(1)
    await flushPromises()
    const agent = wrapper.find('[data-testid="assistant-agent"]')
    expect(agent.exists()).toBe(true)
    expect(agent.text()).toContain('NCTNCT 4')
    expect(agent.text()).toContain('B26071801')
    expect(agentMock).toHaveBeenCalledWith({ q: 'M26057 vezérlés', language: 'hu' })
  })

  it('renders the tool-trace chips and the meta line', async () => {
    agentMock.mockResolvedValueOnce(
      sampleAgent({
        tool_trace: [
          { name: 'answer_question', args: { q: 'M26057 vezérlés' }, ok: true },
          { name: 'get_ticket_stats', args: { group_by: 'customer' }, ok: false, note: 'HTTP 400' },
        ],
        iterations: 3,
      }),
    )
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('teszt')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    const trace = wrapper.get('[data-testid="agent-trace"]')
    expect(trace.text()).toContain('answer_question')
    expect(trace.text()).toContain('get_ticket_stats')
    expect(wrapper.find('[data-testid="agent-trace-get_ticket_stats"]').classes()).toContain('text-danger')
    expect(wrapper.get('[data-testid="agent-meta"]').text()).toContain('3 lépés')
    expect(wrapper.get('[data-testid="agent-meta"]').text()).toContain('openai/gpt-4o-mini')
  })

  it('shows the pulsing AI icon while the agent is responding', async () => {
    let resolve!: (v: AnswerAgentResponse) => void
    agentMock.mockReturnValueOnce(new Promise<AnswerAgentResponse>((r) => { resolve = r }))
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    // pending: icon + text visible
    expect(wrapper.find('[data-testid="agent-thinking"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-thinking-icon"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Gondolkodom')
    // resolve → icon goes away, answer appears
    resolve(sampleAgent())
    await flushPromises()
    expect(wrapper.find('[data-testid="agent-thinking"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="assistant-agent"]').exists()).toBe(true)
  })

  it('renders a humanized error bubble and Retry re-runs the request', async () => {
    agentMock
      .mockRejectedValueOnce({
        status: 503,
        message: 'HTTP 503',
        body: { error: 'cmms-api unavailable', hint: 'cmms-api may be reloading. Try again in a minute.' },
      })
      .mockResolvedValueOnce(sampleAgent())
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('teszt')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    const errBubble = wrapper.find('[data-testid="assistant-error"]')
    expect(errBubble.exists()).toBe(true)
    expect(errBubble.text()).toContain('CMMS API nem elérhet')

    await wrapper.get('[data-testid="inline-error-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="assistant-agent"]').length).toBe(1)
  })

  it('splits threads by resolved_customer from the agent response', async () => {
    agentMock.mockResolvedValueOnce(sampleAgent({ resolved_customer: 'ANDRITZ KFT.' }))
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('andritz tavaly')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    // thread switcher now shows the customer thread, titled by its FIRST
    // user message (not the raw customer key)
    expect(wrapper.get('[data-testid="thread-switcher"]').text()).toContain('andritz tavaly')
    // the message landed in the customer thread
    const store = useAskStore()
    expect(store.threadKey).toBe('ANDRITZ KFT.')
    expect(store.messages.length).toBe(2) // user + assistant
  })

  it('titles threads by the first user message', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    store.switchThread('ANDRITZ KFT.')
    store.push({ role: 'user', text: 'andritz tavaly mennyi volt?', ts: Date.now() - 2000 })
    store.push({ role: 'assistant', text: '3 nyitott jegy.', ts: Date.now() })
    const entry = store.index.find((t) => t.key === 'ANDRITZ KFT.')
    expect(entry?.title).toBe('andritz tavaly mennyi volt?')

    const wrapper = mountAskPage(pinia)
    expect(wrapper.get('[data-testid="thread-switcher"]').text()).toContain('andritz tavaly mennyi volt?')
    // the menu row shows the same title (no duplicate "General" rows,
    // no raw customer-key names)
    await wrapper.get('[data-testid="thread-switcher"]').trigger('click')
    const option = wrapper.get('[data-testid="thread-option-ANDRITZ KFT."]')
    expect(option.text()).toContain('andritz tavaly mennyi volt?')
    expect(wrapper.findAll('[data-testid="thread-option-general"]').length).toBe(0)
  })

  it('Új beszélgetés starts a fresh empty thread without losing history', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    // both a customer thread and the general thread have history, so the
    // new-chat button must mint a fresh thread instead of reusing them
    store.switchThread('ANDRITZ KFT.')
    store.push({ role: 'user', text: 'andritz tavaly', ts: Date.now() - 5000 })
    store.push({ role: 'assistant', text: 'x', ts: Date.now() - 4000 })
    store.switchThread('general')
    store.push({ role: 'user', text: 'hello', ts: Date.now() - 3000 })
    store.push({ role: 'assistant', text: 'hi', ts: Date.now() - 2000 })

    const wrapper = mountAskPage(pinia)
    await wrapper.get('[data-testid="thread-new-chat-btn"]').trigger('click')
    expect(store.messages.length).toBe(0)
    expect(store.threadKey.startsWith('chat-')).toBe(true)
    // the old threads stay in the index
    expect(store.index.some((t) => t.key === 'ANDRITZ KFT.')).toBe(true)
    expect(store.index.some((t) => t.key === 'general')).toBe(true)

    // the menu's "Új beszélgetés" button does the same
    await wrapper.get('[data-testid="thread-new-chat-btn"]').trigger('click')
    await wrapper.get('[data-testid="thread-switcher"]').trigger('click')
    await wrapper.get('[data-testid="thread-new-chat"]').trigger('click')
    expect(store.messages.length).toBe(0)
  })

  it('styles **bold** markup in agent answers and keeps sorszam clickable', async () => {
    agentMock.mockResolvedValueOnce(
      sampleAgent({
        final_text:
          'Az M26057 gépen található vezérlés: **NCTNCT 4**. Forrás: **B26071801** (PLASMA-TECH).',
      }),
    )
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    const strong = wrapper.findAll('[data-testid="agent-body-text"] strong')
    expect(strong.length).toBe(2)
    expect(strong[0]!.text()).toContain('NCTNCT 4')
    expect(strong[1]!.text()).toContain('B26071801')
    // the sorszam token inside the **bold** run is still clickable
    expect(wrapper.find('[data-testid="sorszam-link-B26071801"]').exists()).toBe(true)
  })

  it('renders stored legacy AnswerBody history (meta.answer) untouched', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    store.push({ role: 'user', text: 'M26057 vezérlés', ts: Date.now() - 1000 })
    store.push({ role: 'assistant', text: '1 ticket található', ts: Date.now(), meta: { answer: sampleAnswer() } })

    const wrapper = mountAskPage(pinia)
    // legacy answer still renders its rich body + evidence card row
    expect(wrapper.findAll('[data-testid="assistant-answer"]').length).toBe(1)
    expect(wrapper.text()).toContain('M-2026/0123')
    expect(wrapper.findAll('[data-testid="evidence-ticket-M-2026/0123"]').length).toBe(1)
  })
})
