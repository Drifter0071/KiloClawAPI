// tests/ask.spec.ts
//
// AskPage (src/routes/AskPage.vue) — STREAMING agentic path
// (2026-08-19 redesign). The page now POSTs /v1/answer-agent/stream
// and consumes SSE frames live:
//   - progressive disclosure: status phase + tool_start/tool_done chips
//     + token-by-token final text (features #1 + #2);
//   - same-thread history + machine-scope context in the request
//     (features #3 + #6);
//   - async-poll fallback when the stream is unavailable (transport
//     error / non-SSE content-type from an old proxy);
//   - `error` SSE frame → error bubble, NO fallback (hard-fail);
//   - voice mic hidden when SpeechRecognition is unsupported (#5).
//
// The api layer is mocked at @/composables/useApi; answerAgentStream
// returns a fake Response whose body is a controllable ReadableStream,
// so the real consumeAgentStream() SSE parser runs in the test.
//
// GFM-table / heading rendering tests mount AgentBody directly (pure
// markdown parsing, no network).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AskPage from '../src/routes/AskPage.vue'
import AgentBody from '../src/components/AgentBody.vue'
import { useAskStore } from '../src/stores/ask'
import { useMachineScope } from '../src/composables/useMachineScope'
import type { AnswerAgentResponse, AnswerResponse } from '../src/lib/api'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  streamMock,
  asyncMock,
  pollMock,
  devicesMock,
  voteMock,
  correctionMock,
} = vi.hoisted(() => ({
  streamMock: vi.fn(),
  asyncMock: vi.fn(),
  pollMock: vi.fn(),
  devicesMock: vi.fn(),
  voteMock: vi.fn(),
  correctionMock: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({
    answerAgentStream: streamMock,
    answerAgentAsync: asyncMock,
    answerAgentPoll: pollMock,
    devices: devicesMock,
    submitFeedbackVote: voteMock,
    submitFeedbackCorrection: correctionMock,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { fullPath: '/ask' } } }),
}))

// The my-votes / my-corrections composables fetch on mount to hydrate
// prior votes. Without a real server that fetch would hang. Stub it
// ONLY for tests that touch the vote bar (see stubFeedbackFetch).
function stubFeedbackFetch(): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.includes('/dashboard/api/feedback/my-votes') || url.includes('/dashboard/api/feedback/my-corrections')) {
      return Promise.resolve(new Response(JSON.stringify({ votes: {}, corrections: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }))
}

// ---------------------------------------------------------------------------
// Fake SSE helpers — the stream's body is a real ReadableStream so the
// page's consumeAgentStream() framing parser executes for real.
// ---------------------------------------------------------------------------

type SseFrame = { event: string; data: unknown }

function encodeFrames(frames: SseFrame[]): Uint8Array[] {
  const encoder = new TextEncoder()
  return frames.map((f) => encoder.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`))
}

/** A Response whose SSE body can be pushed frame-by-frame from the test. */
function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const push = (event: string, data: unknown): void => {
    controller.enqueue(encodeFrames([{ event, data }])[0]!)
  }
  const close = (): void => controller.close()
  return { stream, push, close }
}

/** A pre-baked SSE Response (all frames at once). */
function sseResponse(frames: SseFrame[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of encodeFrames(frames)) c.enqueue(chunk)
      c.close()
    },
  })
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
  } as unknown as Response
}

/** An ok JSON Response (old proxy / non-SSE content type). */
function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

function sampleAgent(overrides: Partial<AnswerAgentResponse> = {}): AnswerAgentResponse {
  return {
    answer_id: '01HAGENTTEST0000000000000',
    final_text: 'Az M26057 vezérlése: NCTNCT 4. (forrás: B26071801, PLASMA-TECH SYSTEMS KFT.)',
    tool_trace: [
      { name: 'answer_question', args: { q: 'M26057 vezérlés' }, ok: true },
      { name: 'search_tickets', args: { device: 'M26057' }, ok: true },
    ],
    iterations: 2,
    model: 'openai/gpt-4o-mini',
    resolved_customer: null,
    language: 'hu',
    soft_deadline_forced: false,
    ...overrides,
  }
}

function sampleAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    answer_id: '01HANSWERTEST000000000000',
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

describe('AskPage (streaming agentic)', () => {
  beforeEach(() => {
    streamMock.mockReset()
    asyncMock.mockReset()
    pollMock.mockReset()
    devicesMock.mockReset()
    voteMock.mockReset()
    correctionMock.mockReset()
    vi.unstubAllGlobals()
    // Per-client threads persist to localStorage; vitest reuses the
    // happy-dom window across tests, so start clean every time. The
    // machine-scope singleton is module-level + localStorage-backed;
    // clear it too so scope never leaks between tests.
    localStorage.clear()
    useMachineScope().clearScope()
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

  it('shows the machine-scope picker in the hero and hides the mic when SpeechRecognition is unsupported', () => {
    // happy-dom has no SpeechRecognition → voiceSupported is false →
    // AskBar must not render the mic button.
    const wrapper = mountAskPage()
    expect(wrapper.find('[data-testid="machine-scope-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-bar-mic"]').exists()).toBe(false)
  })

  it('submits via the SSE stream and renders the agentic answer', async () => {
    streamMock.mockResolvedValueOnce(
      sseResponse([
        { event: 'status', data: { phase: 'start' } },
        { event: 'status', data: { phase: 'searching' } },
        { event: 'token', data: { text: 'Az M26057 ' } },
        { event: 'token', data: { text: 'vezérlése: NCTNCT 4.' } },
        { event: 'answer', data: sampleAgent() },
      ]),
    )
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    // user bubble pushed synchronously
    expect(wrapper.findAll('[data-testid="user-message"]').length).toBe(1)
    await flushPromises()
    const agent = wrapper.find('[data-testid="assistant-agent"]')
    expect(agent.exists()).toBe(true)
    expect(agent.text()).toContain('NCTNCT 4')
    expect(agent.text()).toContain('B26071801')
    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledWith({ q: 'M26057 vezérlés', language: 'hu' })
    // The stream is terminal — no async-poll calls happened.
    expect(asyncMock).not.toHaveBeenCalled()
    expect(pollMock).not.toHaveBeenCalled()
  })

  it('streams the live bubble: phase → tool chips → token text → final answer', async () => {
    const { stream, push, close } = controllableStream()
    streamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    } as unknown as Response)
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    // Stream is open → the progressive-disclosure bubble replaced the
    // static "Gondolkodom…" indicator.
    expect(wrapper.find('[data-testid="agent-thinking"]').exists()).toBe(false)
    const bubble = wrapper.find('[data-testid="assistant-streaming"]')
    expect(bubble.exists()).toBe(true)

    push('status', { phase: 'searching' })
    await flushPromises()
    expect(wrapper.text()).toContain('Keresek a ticketekben…')

    // Tool round: chip appears with a spinner (no ok yet).
    push('tool_start', { name: 'answer_question', args: { q: 'M26057 vezérlés' } })
    await flushPromises()
    const chip = wrapper.find('[data-testid="streaming-tool-answer_question"]')
    expect(chip.exists()).toBe(true)
    push('tool_done', { name: 'answer_question', ok: true, summary: '1 ticket' })
    await flushPromises()
    expect(wrapper.find('[data-testid="streaming-tool-answer_question"] svg').exists()).toBe(true)

    // Final-answer round: tokens appear live in the streaming text.
    push('token', { text: 'Válasz: ' })
    push('token', { text: 'NCTNCT 4' })
    await flushPromises()
    expect(wrapper.get('[data-testid="streaming-text"]').text()).toContain('NCTNCT 4')

    // Terminal answer frame → bubble is replaced by the persisted answer.
    push('answer', sampleAgent())
    close()
    await flushPromises()
    expect(wrapper.find('[data-testid="assistant-streaming"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="assistant-agent"]').exists()).toBe(true)
  })

  it('renders the tool-trace chips and the meta line in the final answer', async () => {
    streamMock.mockResolvedValueOnce(
      sseResponse([
        { event: 'answer', data: sampleAgent({
          tool_trace: [
            { name: 'answer_question', args: { q: 'M26057 vezérlés' }, ok: true },
            { name: 'get_ticket_stats', args: { group_by: 'customer' }, ok: false, note: 'HTTP 400' },
          ],
          iterations: 3,
        }) },
      ]),
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

  it('shows the pulsing AI icon while the stream request is pending', async () => {
    // The fetch promise never resolves → busy stays true, the stream
    // has not opened yet → the static "Gondolkodom…" indicator shows.
    streamMock.mockReturnValueOnce(new Promise(() => {}))
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    expect(wrapper.find('[data-testid="agent-thinking"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-thinking-icon"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Gondolkodom')
  })

  it('renders a humanized error bubble for an `error` SSE frame and Retry re-runs the stream (hard-fail, no poll)', async () => {
    streamMock
      .mockResolvedValueOnce(
        sseResponse([
          { event: 'error', data: { code: 'agent_failed', message: 'LLM request failed: HTTP 502' } },
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([{ event: 'answer', data: sampleAgent() }]),
      )
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('teszt')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    const errBubble = wrapper.find('[data-testid="assistant-error"]')
    expect(errBubble.exists()).toBe(true)
    expect(errBubble.text()).toContain('LLM request failed: HTTP 502')
    // Hard-fail contract: the error frame is definitive — NO async
    // fallback was attempted.
    expect(asyncMock).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="inline-error-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="assistant-agent"]').length).toBe(1)
    expect(streamMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the async-poll job when the stream transport fails, carrying the same payload', async () => {
    // Stream transport error → POST the same payload as an async job
    // (with history + context), poll until done, render the answer.
    streamMock.mockRejectedValueOnce({ status: 0, message: 'Network error', body: undefined })
    const job = { job_id: 'job-1', status: 'running' }
    asyncMock.mockResolvedValueOnce(job)
    pollMock.mockResolvedValueOnce({ job_id: 'job-1', status: 'done', result: sampleAgent() })

    const { setDevice } = useMachineScope()
    setDevice('M-26057')
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    // First poll happens after AGENT_POLL_INTERVAL_MS (3s) — the payload
    // assertion runs before the sleep resolves.
    await flushPromises()
    expect(asyncMock).toHaveBeenCalledWith({ q: 'M26057 vezérlés', language: 'hu', context: { device: 'M-26057' } })
    await vi.waitFor(() => expect(pollMock).toHaveBeenCalledWith('job-1'), { timeout: 10_000 })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="assistant-agent"]').exists()).toBe(true), { timeout: 10_000 })
  })

  it('falls back to the async-poll job when the proxy returns non-SSE content-type (old dashboard server)', async () => {
    streamMock.mockResolvedValueOnce(jsonResponse({ error: 'not a stream' }))
    // Legacy proxy fallback: the async endpoint may return the finished
    // answer directly instead of a job handle — accept it as-is.
    asyncMock.mockResolvedValueOnce({ ...sampleAgent() } as never)
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('kábel hiba')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="assistant-agent"]').exists()).toBe(true)
    expect(asyncMock).toHaveBeenCalledTimes(1)
    expect(asyncMock).toHaveBeenCalledWith({ q: 'kábel hiba', language: 'hu' })
  })

  it('splits threads by resolved_customer from the streamed answer', async () => {
    streamMock.mockResolvedValueOnce(
      sseResponse([{ event: 'answer', data: sampleAgent({ resolved_customer: 'ANDRITZ KFT.' }) }]),
    )
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('andritz tavaly')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    // thread switcher now shows the customer thread, titled by its FIRST
    // user message (not the raw customer key)
    expect(wrapper.get('[data-testid="thread-switcher"]').text()).toContain('andritz tavaly')
    const store = useAskStore()
    expect(store.threadKey).toBe('ANDRITZ KFT.')
    expect(store.messages.length).toBe(2) // user + assistant
  })

  it('sends same-thread history + machine-scope context in the stream request (payload captured BEFORE the user message)', async () => {
    streamMock.mockResolvedValueOnce(
      sseResponse([{ event: 'answer', data: sampleAgent() }]),
    )
    const { setDevice } = useMachineScope()
    setDevice('M-26057')
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    // A prior exchange in the active (general) thread.
    store.push({ role: 'user', text: 'Milyen gépeitek vannak?', ts: Date.now() - 4000 })
    store.push({ role: 'assistant', text: 'Van egy M-26057.', ts: Date.now() - 3000 })

    const wrapper = mountAskPage(pinia)
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 állapota?')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(streamMock).toHaveBeenCalledWith({
      q: 'M26057 állapota?',
      language: 'hu',
      history: [
        { role: 'user', text: 'Milyen gépeitek vannak?' },
        { role: 'assistant', text: 'Van egy M-26057.' },
      ],
      context: { device: 'M-26057' },
    })
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
    await wrapper.get('[data-testid="thread-switcher"]').trigger('click')
    const option = wrapper.get('[data-testid="thread-option-ANDRITZ KFT."]')
    expect(option.text()).toContain('andritz tavaly mennyi volt?')
    expect(wrapper.findAll('[data-testid="thread-option-general"]').length).toBe(0)
  })

  it('Új beszélgetés starts a fresh empty thread without losing history', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
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
    expect(store.index.some((t) => t.key === 'ANDRITZ KFT.')).toBe(true)
    expect(store.index.some((t) => t.key === 'general')).toBe(true)

    await wrapper.get('[data-testid="thread-new-chat-btn"]').trigger('click')
    await wrapper.get('[data-testid="thread-switcher"]').trigger('click')
    await wrapper.get('[data-testid="thread-new-chat"]').trigger('click')
    expect(store.messages.length).toBe(0)
  })

  // 2026-08-24 bug: the user opens a new chat ("Új beszélgetés") and
  // asks a question that resolves to a customer. The auto-split moved
  // the user question + the answer to the OLD customer thread and
  // removed the new chat — exactly opposite of what the user asked
  // for. Fix: when the submit key is a `chat-*` thread, never
  // auto-split, always land the answer in the new chat.
  it('Új beszélgetés → question in new chat is NOT auto-split to the resolved customer thread', async () => {
    streamMock.mockResolvedValueOnce(
      sseResponse([{ event: 'answer', data: sampleAgent({
        resolved_customer: 'ANDRITZ KFT.',
        final_text: 'Az ANDRITZ Kft.-nél 3 nyitott jegy van.',
      }) }]),
    )
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    // Pre-existing customer thread with prior history.
    store.switchThread('ANDRITZ KFT.')
    store.push({ role: 'user', text: 'régi andritz kérdés', ts: Date.now() - 5000 })
    store.push({ role: 'assistant', text: 'régi andritz válasz', ts: Date.now() - 4000 })
    // Also pre-populate the general thread so startNewChat() mints a
    // `chat-*` key (it reuses the general thread when empty, which
    // is the default state right after page load).
    store.switchThread('general')
    store.push({ role: 'user', text: 'régebbi kérdés', ts: Date.now() - 3000 })
    store.push({ role: 'assistant', text: 'régebbi válasz', ts: Date.now() - 2000 })

    const wrapper = mountAskPage(pinia)
    // Open a fresh "Új beszélgetés" — since general is non-empty,
    // startNewChat() mints a `chat-*` key.
    await wrapper.get('[data-testid="thread-new-chat-btn"]').trigger('click')
    const newChatKey = store.threadKey
    expect(newChatKey.startsWith('chat-')).toBe(true)

    // Ask a question that resolves to ANDRITZ KFT. (a customer
    // different from the new chat's key).
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('mennyi jegy van andritznál most?')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    // The fix: the new chat keeps BOTH the user message AND the
    // assistant answer. The auto-split is suppressed because the
    // submit key is a `chat-*` thread (an explicit "fresh chat").
    // `store.messages` is the active thread's view — when the fix
    // works, the user question + answer stay in the new chat.
    const active = store.messages
    expect(active.length).toBe(2)
    expect(active[0]!.role).toBe('user')
    expect(active[0]!.text).toContain('andritznál')
    expect(active[1]!.role).toBe('assistant')
    expect(active[1]!.text).toContain('ANDRITZ Kft.')
    // Active view stays on the new chat (no auto-switch to the
    // customer thread).
    expect(store.threadKey).toBe(newChatKey)
  })

  it('styles **bold** markup in agent answers and keeps sorszam clickable', async () => {
    streamMock.mockResolvedValueOnce(
      sseResponse([{ event: 'answer', data: sampleAgent({
        final_text: 'Az M26057 gépen található vezérlés: **NCTNCT 4**. Forrás: **B26071801** (PLASMA-TECH).',
      }) }]),
    )
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    const strong = wrapper.findAll('[data-testid="agent-body-text"] strong')
    expect(strong.length).toBe(2)
    expect(strong[0]!.text()).toContain('NCTNCT 4')
    expect(strong[1]!.text()).toContain('B26071801')
    expect(wrapper.find('[data-testid="sorszam-link-B26071801"]').exists()).toBe(true)
  })

  it('renders a GFM pipe-table from final_text as a real <table>', async () => {
    const wrapper = mount(AgentBody, {
      props: {
        data: sampleAgent({
          final_text: [
            'A top 5 ügyfél az elmúlt évben:',
            '',
            '| # | Ügyfél | Jegyek |',
            '|---|--------|-------:|',
            '| 1 | **MSK HUNGARY BT.** | 90 |',
            '| 2 | ARZENÁL FEGYVERGYÁR ZRT. | 82 |',
            '| 3 | SZOLNOKI SZAKKÉPZÉSI CENTRUM | 81 |',
            '| 4 | MST ENGINEERING KFT. | 73 |',
            '| 5 | KOKILLA PREC KFT. | 64 |',
          ].join('\n'),
        }),
      },
    })

    const table = wrapper.find('[data-testid="agent-body-table-element-1"]')
    expect(table.exists()).toBe(true)
    expect(table.element.tagName).toBe('TABLE')
    const ths = wrapper.findAll('[data-testid^="agent-body-table-th-1-"]')
    expect(ths.length).toBe(3)
    expect(ths[2]!.classes().join(' ')).toContain('text-right')
    expect(ths[2]!.text()).toBe('Jegyek')
    const row0 = wrapper.find('[data-testid="agent-body-table-row-1-0"]')
    expect(row0.exists()).toBe(true)
    const r0cells = row0.findAll('td')
    expect(r0cells.length).toBe(3)
    const r0c1 = wrapper.find('[data-testid="agent-body-table-td-1-0-1"]')
    expect(r0c1.find('strong').exists()).toBe(true)
    expect(r0c1.text()).toContain('MSK HUNGARY BT.')
    const lastCell = wrapper.find('[data-testid="agent-body-table-td-1-0-2"]')
    expect(lastCell.classes().join(' ')).toContain('text-right')
    expect(lastCell.text()).toBe('90')
    expect(wrapper.find('[data-testid="agent-body-block-0"]').text()).toBe(
      'A top 5 ügyfél az elmúlt évben:',
    )
  })

  it('falls back to plain text when a block is not a valid GFM table', async () => {
    const wrapper = mount(AgentBody, {
      props: {
        data: sampleAgent({
          final_text: ['Nem-táblázat:', '', '| a | b |', '| c | d |'].join('\n'),
        }),
      },
    })
    expect(wrapper.find('[data-testid^="agent-body-table-element-"]').exists()).toBe(false)
    const block = wrapper.find('[data-testid="agent-body-block-1"]')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('| a | b |')
  })

  it('renders an ATX heading (## …) as <h2> and keeps inline **bold** inside it', async () => {
    const wrapper = mount(AgentBody, {
      props: {
        data: sampleAgent({
          final_text: ['## M17191 gép előélete', '', 'A gép 2024 óta nálunk van. Hibák:'].join('\n'),
        }),
      },
    })
    const h = wrapper.find('[data-testid="agent-body-heading-0"]')
    expect(h.exists()).toBe(true)
    expect(h.element.tagName).toBe('H2')
    expect(h.attributes('data-heading-level')).toBe('2')
    expect(h.text()).toBe('M17191 gép előélete')
    expect(wrapper.find('[data-testid="agent-body-block-1"]').text()).toBe(
      'A gép 2024 óta nálunk van. Hibák:',
    )
  })

  it('renders **bold** inside a heading line as <strong> nested in the <h2>', async () => {
    const wrapper = mount(AgentBody, {
      props: { data: sampleAgent({ final_text: '## **M17191** gép előélete' }) },
    })
    const h = wrapper.find('[data-testid="agent-body-heading-0"]')
    expect(h.exists()).toBe(true)
    const strongs = h.findAll('strong')
    expect(strongs.length).toBe(1)
    expect(strongs[0]!.text()).toBe('M17191')
    expect(h.text()).toBe('M17191 gép előélete')
  })

  it('handles multiple heading levels (h1..h4) with the matching tag', async () => {
    const wrapper = mount(AgentBody, {
      props: {
        data: sampleAgent({
          final_text: [
            '# Címsor 1',
            '',
            '## Címsor 2',
            '',
            '### Címsor 3',
            '',
            '#### Címsor 4',
          ].join('\n'),
        }),
      },
    })
    expect(wrapper.find('[data-testid="agent-body-heading-0"]').element.tagName).toBe('H1')
    expect(wrapper.find('[data-testid="agent-body-heading-1"]').element.tagName).toBe('H2')
    expect(wrapper.find('[data-testid="agent-body-heading-2"]').element.tagName).toBe('H3')
    expect(wrapper.find('[data-testid="agent-body-heading-3"]').element.tagName).toBe('H4')
  })

  it('renders stored legacy AnswerBody history (meta.answer) untouched', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    store.push({ role: 'user', text: 'M26057 vezérlés', ts: Date.now() - 1000 })
    store.push({ role: 'assistant', text: '1 ticket található', ts: Date.now(), meta: { answer: sampleAnswer() } })

    const wrapper = mountAskPage(pinia)
    expect(wrapper.findAll('[data-testid="assistant-answer"]').length).toBe(1)
    expect(wrapper.text()).toContain('M-2026/0123')
    expect(wrapper.findAll('[data-testid="evidence-ticket-M-2026/0123"]').length).toBe(1)
  })

  it('renders a like / dislike vote bar under each assistant bubble', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    const agentId = '01HAGENTTEST0000000000000'
    const answerId = '01HANSWERTEST000000000000'
    store.push({ role: 'user', text: 'A?', ts: Date.now() - 2000 })
    store.push({
      role: 'assistant',
      text: 'agent válasz',
      ts: Date.now() - 1500,
      meta: { agent: sampleAgent({ answer_id: agentId }) },
    })
    store.push({ role: 'user', text: 'B?', ts: Date.now() - 1000 })
    store.push({
      role: 'assistant',
      text: 'router válasz',
      ts: Date.now(),
      meta: { answer: sampleAnswer({ answer_id: answerId }) },
    })

    const wrapper = mountAskPage(pinia)
    expect(wrapper.findAll('[data-testid="answer-vote-bar"]').length).toBe(2)
    expect(wrapper.findAll('[data-testid="answer-vote-bar-like"]').length).toBe(2)
    expect(wrapper.findAll('[data-testid="answer-vote-bar-dislike"]').length).toBe(2)
  })

  it('dislike → reason modal → inline "Küldd el" link → CorrectionModal → correction message in thread', async () => {
    stubFeedbackFetch()
    voteMock.mockResolvedValue({ ok: true, vote: -1, answer_id: '01HCORR00000000000000000' })
    correctionMock.mockResolvedValue({
      ok: true,
      answer_id: '01HCORR00000000000000000',
      correction: 'A helyes ügyfél ACME Kft.',
      created_at: '2026-08-19T12:00:00.000Z',
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    const answerId = '01HCORR00000000000000000'
    store.push({ role: 'user', text: 'M26057?', ts: Date.now() - 1000 })
    store.push({
      role: 'assistant',
      text: 'agent válasz',
      ts: Date.now(),
      meta: { agent: sampleAgent({ answer_id: answerId }) },
    })
    const wrapper = mountAskPage(pinia)

    expect(wrapper.findAll(`[data-testid="send-correct-answer-${answerId}"]`).length).toBe(0)

    const dislikeBtn = wrapper.findAll('[data-testid="answer-vote-bar-dislike"]')[0]
    expect(dislikeBtn.exists()).toBe(true)
    await dislikeBtn.trigger('click')
    await flushPromises()
    // The vote MUST NOT have been submitted yet — the reason modal is the gate.
    expect(voteMock).not.toHaveBeenCalled()
    const reasonModal = document.querySelector('[data-testid="dislike-reason-modal"]') as HTMLElement
    expect(reasonModal).toBeTruthy()
    expect(wrapper.findAll(`[data-testid="send-correct-answer-${answerId}"]`).length).toBe(0)

    const radio0 = document.querySelector('[data-testid="dislike-reason-radio-0"]') as HTMLInputElement
    radio0.click()
    await nextTick()
    const reasonSubmit = document.querySelector('[data-testid="dislike-reason-submit"]') as HTMLButtonElement
    reasonSubmit.click()
    await flushPromises()

    expect(voteMock).toHaveBeenCalledTimes(1)
    expect(voteMock).toHaveBeenCalledWith({
      answer_id: answerId,
      vote: -1,
      reason: 'wrong customer/device',
    })
    const link = wrapper.find(`[data-testid="send-correct-answer-${answerId}"]`)
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('Tudod a helyes választ?')
    expect(link.text()).toContain('Küldd el')

    await link.trigger('click')
    await flushPromises()
    const modal = document.querySelector('[data-testid="correction-modal"]') as HTMLElement
    expect(modal).toBeTruthy()

    const ta = modal.querySelector('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    ta.value = 'A helyes ügyfél ACME Kft.'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(modal.querySelector('[data-testid="correction-submit"]') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(correctionMock).toHaveBeenCalledWith({
      answer_id: answerId,
      correction: 'A helyes ügyfél ACME Kft.',
    })
    // No chat message is appended — the correction is a meta-action.
    const last = store.messages[store.messages.length - 1]
    expect(last.role).toBe('assistant')

    const sentBtn = wrapper.find(`[data-testid="send-correct-answer-sent-${answerId}"]`)
    expect(sentBtn.exists()).toBe(true)
    expect(sentBtn.text()).toContain('Visszajelzés elküldve')
    expect(wrapper.find(`[data-testid="send-correct-answer-${answerId}"]`).exists()).toBe(false)
  })

  it('un-dislike hides the "Küldd el" link', async () => {
    stubFeedbackFetch()
    voteMock
      .mockResolvedValueOnce({ ok: true, vote: -1, answer_id: '01HUNDISLIKE00000000000' })
      .mockResolvedValueOnce({ ok: true, vote: 0, answer_id: '01HUNDISLIKE00000000000' })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useAskStore()
    const answerId = '01HUNDISLIKE00000000000'
    store.push({ role: 'user', text: 'A?', ts: Date.now() - 1000 })
    store.push({
      role: 'assistant',
      text: 'válasz',
      ts: Date.now(),
      meta: { agent: sampleAgent({ answer_id: answerId }) },
    })
    const wrapper = mountAskPage(pinia)
    const dislike = wrapper.findAll('[data-testid="answer-vote-bar-dislike"]')[0]
    await dislike.trigger('click')
    await flushPromises()
    const reasonModal = document.querySelector('[data-testid="dislike-reason-modal"]') as HTMLElement
    expect(reasonModal).toBeTruthy()
    ;(document.querySelector('[data-testid="dislike-reason-radio-0"]') as HTMLInputElement).click()
    await nextTick()
    ;(document.querySelector('[data-testid="dislike-reason-submit"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(voteMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find(`[data-testid="send-correct-answer-${answerId}"]`).exists()).toBe(true)
    // Second click is the un-vote — bypasses the reason modal.
    await dislike.trigger('click')
    await flushPromises()
    expect(voteMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find(`[data-testid="send-correct-answer-${answerId}"]`).exists()).toBe(false)
  })
})
