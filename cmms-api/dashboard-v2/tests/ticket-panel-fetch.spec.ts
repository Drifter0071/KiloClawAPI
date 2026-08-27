// tests/ticket-panel-fetch.spec.ts
//
// Tests the TicketPanel's background useApi().answer() fetch — the
// panel should project the first result row's kategoria /
// sulyossag_inferred / snippet into the visible fields, and show
// a "no details" hint when the answer returns no results.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import TicketPanel from '../src/components/TicketPanel.vue'
import type { EvidenceTicket } from '@/lib/api'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { answerMock } = vi.hoisted(() => ({
  answerMock: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ answer: answerMock }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

function makeTicket(sorszam: string): EvidenceTicket {
  return {
    sorszam,
    key: sorszam,
    reported_at_iso: '',
    snippet: '',
    kategoria: null,
    kategoria_inferred: null,
    sulyossag_inferred: null,
  }
}

function mountPanel(ticket: EvidenceTicket) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(TicketPanel, {
    props: { open: true, ticket },
    global: {
      plugins: [createPinia(), [VueQueryPlugin, { queryClient }]],
    },
  })
}

describe('TicketPanel — background fetch', () => {
  beforeEach(() => {
    answerMock.mockReset()
  })

  it('populates kategoria + sulyossag + snippet from the first answer result row', async () => {
    answerMock.mockResolvedValueOnce({
      mode: 'answer',
      q: 'ticket B26071801',
      language: 'hu',
      intent: 'device_tickets_list',
      primitive: 'search_existing_tickets',
      group_by: null,
      filters: {},
      period: null,
      summary: 'B26071801: Vezérlő hiba javítva',
      follow_ups: [],
      results: [
        {
          sorszam: 'B26071801',
          snippet: 'Vezérlő hiba — PLC újraprogramozva',
          kategoria: 'Vezérlő hiba',
          sulyossag_inferred: 'magas',
        },
      ],
      evidence: {},
      total: 1,
      rationale: '',
      confidence: 1,
      threshold: 0.6,
      candidates: [],
      mode_rationale: '',
    })

    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()

    // The header shows the sorszam.
    expect(wrapper.get('[data-testid="ticket-panel-sorszam"]').text()).toBe('B26071801')

    // The populated fields. The default EmptyState hint is NOT shown.
    expect(wrapper.find('[data-testid="ticket-panel-empty"]').exists()).toBe(false)
    // Kategoria, sulyossag, snippet should all reflect the answer row.
    const meta = wrapper.get('[data-testid="ticket-panel-meta"]').text()
    expect(meta).toContain('Vezérlő hiba')
    expect(meta).toContain('magas')
    expect(wrapper.get('[data-testid="ticket-panel-snippet"]').text()).toContain(
      'PLC újraprogramozva',
    )
  })

  it('shows the "no details" hint when the answer returns zero results', async () => {
    answerMock.mockResolvedValueOnce({
      mode: 'answer',
      q: 'ticket B99999999',
      language: 'hu',
      intent: 'search_existing_tickets',
      primitive: 'search_existing_tickets',
      group_by: null,
      filters: {},
      period: null,
      summary: 'Nincs találat.',
      follow_ups: [],
      results: [],
      evidence: {},
      total: 0,
      rationale: '',
      confidence: 0,
      threshold: 0.6,
      candidates: [],
      mode_rationale: '',
    })

    const wrapper = mountPanel(makeTicket('B99999999'))
    await flushPromises()

    // The empty hint is visible.
    expect(wrapper.find('[data-testid="ticket-panel-empty"]').exists()).toBe(true)
    // The kategoria / sulyossag cells fall back to "—".
    const meta = wrapper.get('[data-testid="ticket-panel-meta"]').text()
    expect(meta).toContain('—')
  })

  it('omits the primary header line when the result sorszam equals the panel sorszam (no redundancy)', async () => {
    answerMock.mockResolvedValueOnce({
      mode: 'answer',
      q: 'ticket B26071801',
      language: 'hu',
      intent: 'device_tickets_list',
      primitive: 'search_existing_tickets',
      group_by: null,
      filters: {},
      period: null,
      summary: 'B26071801',
      follow_ups: [],
      results: [
        {
          sorszam: 'B26071801',
          snippet: 'rövid leírás',
        },
      ],
      evidence: {},
      total: 1,
      rationale: '',
      confidence: 1,
      threshold: 0.6,
      candidates: [],
      mode_rationale: '',
    })

    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    // The primary line is hidden when the projection equals the
    // sorszam — otherwise we'd duplicate the same string under the
    // sorszam header.
    expect(wrapper.find('[data-testid="ticket-panel-primary"]').exists()).toBe(false)
  })

  it('the Megnyitás Ask-ban CTA closes the panel via the update:open emit', async () => {
    const wrapper = mountPanel(makeTicket('B26071801'))
    const cancelBtn = wrapper.get('[data-testid="ticket-panel-open-in-ask"]')
    await cancelBtn.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })
})
