// tests/ask.spec.ts
//
// Phase 5.1 — AskPage (src/routes/AskPage.vue) + AnswerBody.
// Covers: empty state, submit flow, answer rendering, confirm mode
// (Yes re-submits with filters), follow-up chips, error + retry.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AskPage from '../src/routes/AskPage.vue'
import type { AnswerResponse } from '../src/lib/api'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { answerMock } = vi.hoisted(() => ({ answerMock: vi.fn() }))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ answer: answerMock }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { fullPath: '/ask' } } }),
}))

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

function confirmAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return sampleAnswer({
    mode: 'confirm',
    confidence: 0.38,
    summary: 'Nem egyértelmű kérdés',
    candidates: [
      {
        rank: 1,
        intent: 'find_ticket',
        primitive: 'search_tickets',
        score: 0.38,
        score_breakdown: {},
        family: 'other',
        filters: { device: 'M26057', kategoria: 'Szoftver hiba' },
        period: null,
        summary: 'Nem egyértelmű kérdés',
        follow_ups: [],
        results: [],
        evidence: {},
        total: 0,
        rationale: '',
      },
    ],
    ...overrides,
  })
}

function mountAskPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(AskPage, {
    global: {
      plugins: [
        createPinia(),
        [VueQueryPlugin, { queryClient }],
      ],
    },
  })
}

describe('AskPage', () => {
  beforeEach(() => {
    answerMock.mockReset()
    // The ask store persists per-client threads to localStorage; vitest
    // reuses the happy-dom window across tests in this file, so each
    // test must start from a clean slate or messages accumulate.
    localStorage.clear()
  })

  it('renders the hero empty state with example chips and a random greeting', () => {
    const wrapper = mountAskPage()
    expect(wrapper.find('[data-testid="ask-empty"]').exists()).toBe(true)
    // Greeting is a curated Hungarian phrase (single-line, HU-only).
    const greeting = wrapper.get('[data-testid="ask-greeting"]')
    expect(greeting.text().length).toBeGreaterThan(8)
    expect(greeting.text().endsWith('.') || greeting.text().endsWith('?')).toBe(true)
    expect(wrapper.findAll('[data-testid="example-chip"]').length).toBe(4)
  })

  it('submits a question and renders user + assistant messages', async () => {
    answerMock.mockResolvedValueOnce(sampleAnswer())
    const wrapper = mountAskPage()
    const input = wrapper.get('[data-testid="ask-bar-input"]')
    await input.setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    // user bubble pushed synchronously
    expect(wrapper.findAll('[data-testid="user-message"]').length).toBe(1)
    await flushPromises()
    const answers = wrapper.findAll('[data-testid="assistant-answer"]')
    expect(answers.length).toBe(1)
    expect(answers[0]!.text()).toContain('1 ticket található')
    expect(answerMock).toHaveBeenCalledWith({ q: 'M26057 vezérlés', language: 'hu' })
  })

  it('renders results, evidence and the confidence pill in answer mode', async () => {
    answerMock.mockResolvedValueOnce(sampleAnswer())
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('teszt')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="result-row"]').length).toBe(1)
    expect(wrapper.find('[data-testid="confidence-pill"]').text()).toBe('magas')
    expect(wrapper.find('[data-testid="confidence-pill"].bg-success\\/15').exists()).toBe(true)
    expect(wrapper.text()).toContain('M-2026/0123')
  })

  it('confirm mode shows the prompt and Yes re-submits with the candidate filters', async () => {
    answerMock
      .mockResolvedValueOnce(confirmAnswer())
      .mockResolvedValueOnce(sampleAnswer())
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('M26057 vezérlés')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-prompt"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Nem egyértelmű kérdés')

    await wrapper.get('[data-testid="confirm-yes"]').trigger('click')
    await flushPromises()

    // second call carries the winning candidate's filters (device + kategoria)
    const secondCall = answerMock.mock.calls[1]?.[0] as { device?: string; kategoria?: string }
    expect(secondCall.device).toBe('M26057')
    expect(secondCall.kategoria).toBe('Szoftver hiba')
    // history: confirm prompt bubble + final answer bubble
    expect(wrapper.findAll('[data-testid="assistant-answer"]').length).toBe(2)
    expect(wrapper.findAll('[data-testid="confirm-prompt"]').length).toBe(1)
  })

  it('renders follow-up chips and submitting one re-asks', async () => {
    answerMock
      .mockResolvedValueOnce(sampleAnswer())
      .mockResolvedValueOnce(sampleAnswer({ q: 'Show customer' }))
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('teszt')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    const chips = wrapper.findAll('[data-testid="followup-chip"]')
    expect(chips.length).toBe(2)
    await chips[0]!.trigger('click')
    await flushPromises()

    expect(answerMock.mock.calls[1]?.[0]).toMatchObject({ q: 'Show customer' })
    expect(wrapper.findAll('[data-testid="user-message"]').length).toBe(2)
  })

  it('renders a humanized error bubble and Retry re-runs the request', async () => {
    answerMock
      .mockRejectedValueOnce({
        status: 503,
        message: 'HTTP 503',
        body: { error: 'cmms-api unavailable', hint: 'cmms-api may be reloading. Try again in a minute.' },
      })
      .mockResolvedValueOnce(sampleAnswer())
    const wrapper = mountAskPage()
    await wrapper.get('[data-testid="ask-bar-input"]').setValue('teszt')
    await wrapper.get('[data-testid="ask-bar"]').trigger('submit')
    await flushPromises()

    const errBubble = wrapper.find('[data-testid="assistant-error"]')
    expect(errBubble.exists()).toBe(true)
    expect(errBubble.text()).toContain('CMMS API nem elérhet')

    await wrapper.get('[data-testid="inline-error-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="assistant-answer"]').length).toBe(1)
  })
})
