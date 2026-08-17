// tests/ticket-details.spec.ts
//
// Tests for the ticket inspector / panel after the "full ticket
// details" rewrite (Phase 8.1). The new flow calls a dedicated
// /v1/tickets/by-sorszam/:sorszam endpoint (proxied via
// /dashboard/api/ticket) and renders the entire JobCard:
// customer, devices, all notes (reported / work / free), technician,
// kategoria, sulyossag, dates. The old "project the first answer
// result row" projection no longer works for the inspector because
// /v1/answer only ships snippet / kategoria / sulyossag fields.
//
// The previous ticket-panel-fetch.spec.ts asserts the old behavior.
// We replace those assertions here.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import TicketPanel from '../src/components/TicketPanel.vue'
import TicketInspector from '../src/components/TicketInspector.vue'
import type { EvidenceTicket, TicketDetails } from '@/lib/api'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { getTicketMock, routerPushMock } = vi.hoisted(() => ({
  getTicketMock: vi.fn(),
  routerPushMock: vi.fn(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ getTicketBySorszam: getTicketMock }),
}))

let currentPath = '/ask'
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushMock }),
  useRoute: () => ({ path: currentPath, fullPath: currentPath }),
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

function makeDetails(overrides: Partial<TicketDetails> = {}): TicketDetails {
  return {
    key: 1,
    sorszam: 'B26071801',
    reported_at: '2026-07-18',
    reported_at_iso: '2026-07-18T08:30:00.000Z',
    status: 'open',
    technician: 'KK',
    customer: {
      name: 'PLASMA-TECH SYSTEMS KFT.',
      zip: '6000',
      address: 'Budapest, Kossuth u. 1.',
      phone: '+36 30 555 1234',
      email: 'info@plasma-tech.example',
    },
    devices: [
      {
        raw: 'DPB-3-40-ATC-1000 (SN:1234)',
        model: 'DPB-3-40',
        software: null,
        hardware: null,
        servos: null,
        controller: 'NCT104',
        machine_type: 'DPB',
        freeform: 'ATC-1000',
      },
    ],
    notes: [
      {
        kind: 'reported',
        body: 'Vezérlő hiba — PLC nem válaszol az indításkor.',
        author: 'Kovács K.',
        created_at: '2026-07-18T08:30:00.000Z',
      },
      {
        kind: 'work',
        body: 'Helyszíni kiszállás, NCT104 firmware újratelepítve.',
        author: 'Nagy B.',
        created_at: '2026-07-18T14:00:00.000Z',
      },
      {
        kind: 'work',
        body: 'Próbaüzem sikeres, gép újraindítva.',
        author: 'Nagy B.',
        created_at: '2026-07-18T16:30:00.000Z',
      },
    ],
    problem_kategoria: 'Vezérlő hiba',
    problem_alkategoria: null,
    sulyossag: 'magas',
    kategoria_inferred: 'Vezérlő hiba',
    kategoria_inferred_conf: 0.92,
    sulyossag_inferred: 'magas',
    sulyossag_inferred_conf: 0.88,
    alkategoria_inferred: 'NCT104',
    resolution: null,
    ...overrides,
  }
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

function mountPanel(ticket: EvidenceTicket, queryClient = makeQueryClient()) {
  return mount(TicketPanel, {
    props: { open: true, ticket },
    global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] },
  })
}

function mountInspector(ticket: EvidenceTicket, queryClient = makeQueryClient()) {
  return mount(TicketInspector, {
    props: { open: true, ticket },
    attachTo: document.body,
    global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] },
  })
}

/** The TicketInspector uses <Teleport to="body"> — its DOM ends up
 *  in document.body, not inside the wrapper's element. Look it up
 *  there for assertions. */
function findInBody(testid: string): Element | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

describe('TicketPanel — full details (new endpoint)', () => {
  beforeEach(() => {
    getTicketMock.mockReset()
    routerPushMock.mockReset()
    currentPath = '/ask'
  })

  it('calls getTicketBySorszam with the panel sorszam', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    mountPanel(makeTicket('B26071801'))
    await flushPromises()
    expect(getTicketMock).toHaveBeenCalledWith('B26071801')
  })

  it('renders status, kategoria, sulyossag, technician from the resolved ticket', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    const meta = wrapper.get('[data-testid="ticket-details"]').text()
    expect(meta).toContain('Nyitott')
    expect(meta).toContain('Vezérlő hiba')
    expect(meta).toContain('magas')
    expect(meta).toContain('KK')
  })

  it('renders the customer card with name, address, phone, email', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    const card = wrapper.get('[data-testid="ticket-details-customer"]')
    expect(card.text()).toContain('PLASMA-TECH SYSTEMS KFT.')
    expect(card.text()).toContain('6000')
    expect(card.text()).toContain('Budapest, Kossuth u. 1.')
    expect(card.get('[data-testid="ticket-details-phone"]').text()).toContain('+36 30 555 1234')
    expect(card.get('[data-testid="ticket-details-email"]').text()).toContain(
      'info@plasma-tech.example',
    )
  })

  it('renders the devices list with raw + model + controller + machine_type', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    const dev0 = wrapper.get('[data-testid="ticket-details-device-0"]')
    expect(dev0.text()).toContain('DPB-3-40-ATC-1000')
    expect(dev0.text()).toContain('NCT104')
    expect(dev0.text()).toContain('DPB')
  })

  it('renders all notes in lifecycle order, bucketed by kind', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    const notes = wrapper.get('[data-testid="ticket-details-notes"]')
    expect(notes.text()).toContain('Bejelentés')
    expect(notes.text()).toContain('Munka')
    // The reported note (kind=reported) and the two work notes are all rendered.
    expect(notes.text()).toContain('PLC nem válaszol')
    expect(notes.text()).toContain('firmware újratelepítve')
    expect(notes.text()).toContain('Próbaüzem sikeres')
    // Authors are shown too.
    expect(notes.text()).toContain('Kovács K.')
    expect(notes.text()).toContain('Nagy B.')
  })

  it('shows the empty hint when the API returns 404 (sorszam not found)', async () => {
    getTicketMock.mockRejectedValue({
      status: 404,
      message: 'HTTP 404',
      body: { error: { code: 'not_found', message: "ticket 'B99999999' not found" } },
    })
    const wrapper = mountPanel(makeTicket('B99999999'))
    await flushPromises()
    expect(wrapper.find('[data-testid="ticket-details-empty"]').exists()).toBe(true)
  })

  it('shows the loading skeleton before the data lands', async () => {
    let resolveDetails!: (v: TicketDetails) => void
    getTicketMock.mockReturnValueOnce(new Promise<TicketDetails>((r) => { resolveDetails = r }))
    const wrapper = mountPanel(makeTicket('B26071801'))
    // Synchronously after mount: still loading, no resolved body.
    expect(wrapper.find('[data-testid="ticket-details-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ticket-details"]').exists()).toBe(false)
    resolveDetails(makeDetails())
    await flushPromises()
    expect(wrapper.find('[data-testid="ticket-details"]').exists()).toBe(true)
  })
})

describe('TicketPanel — Megnyitás Ask-ban CTA', () => {
  beforeEach(() => {
    getTicketMock.mockReset()
    routerPushMock.mockReset()
  })

  it('emits update:open=false (panel closes)', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    await wrapper.get('[data-testid="ticket-panel-open-in-ask"]').trigger('click')
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('emits openInAsk with the sorszam when already on /ask (no router push)', async () => {
    currentPath = '/ask'
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    await wrapper.get('[data-testid="ticket-panel-open-in-ask"]').trigger('click')
    expect(wrapper.emitted('openInAsk')?.[0]).toEqual(['B26071801'])
    expect(routerPushMock).not.toHaveBeenCalled()
  })

  it('uses setSeedQ (router.push to /ask) when on a different page', async () => {
    currentPath = '/diff'
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountPanel(makeTicket('B26071801'))
    await flushPromises()
    await wrapper.get('[data-testid="ticket-panel-open-in-ask"]').trigger('click')
    expect(wrapper.emitted('openInAsk')?.[0]).toEqual(['B26071801'])
    // setSeedQ issues router.push with the sorszam in history.state
    expect(routerPushMock).toHaveBeenCalledTimes(1)
    const arg = routerPushMock.mock.calls[0]?.[0] as { path: string; state: { seedQ?: string } }
    expect(arg.path).toBe('/ask')
    expect(arg.state?.seedQ).toBe('ticket B26071801')
  })
})

describe('TicketInspector — full details + Megnyitás Ask-ban', () => {
  beforeEach(() => {
    getTicketMock.mockReset()
    routerPushMock.mockReset()
    currentPath = '/ask'
  })

  it('renders the full customer card and notes (same body component as the panel)', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    const inspector = findInBody('ticket-inspector')
    expect(inspector).not.toBeNull()
    const customer = findInBody('ticket-details-customer')
    expect(customer?.textContent ?? '').toContain('PLASMA-TECH SYSTEMS KFT.')
    const notes = findInBody('ticket-details-notes')
    expect(notes?.textContent ?? '').toContain('PLC nem válaszol')
    wrapper.unmount()
  })

  it('emits openInAsk when "Megnyitás Ask-ban" is clicked (no router push on /ask)', async () => {
    currentPath = '/ask'
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    const btn = findInBody('ticket-inspector-open-in-ask') as HTMLElement
    expect(btn).not.toBeNull()
    btn.click()
    await flushPromises()
    expect(wrapper.emitted('openInAsk')?.[0]).toEqual(['B26071801'])
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
    expect(routerPushMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
