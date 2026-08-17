// tests/ticket-details.spec.ts
//
// Tests for the ticket inspector after the "full ticket details"
// rewrite (Phase 8.1) and the 2026-08-17 mobile-chat refactor (the
// in-place TicketPanel was removed; TicketInspector is now the ONLY
// ticket-detail surface — teleported bottom sheet on mobile / right
// drawer on desktop). The new flow calls a dedicated
// /v1/tickets/by-sorszam/:sorszam endpoint (proxied via
// /dashboard/api/ticket) and renders the entire JobCard:
// customer, devices, all notes (reported / work / free), technician,
// kategoria, sulyossag, dates.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
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

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TicketInspector — full details (new endpoint)', () => {
  beforeEach(() => {
    getTicketMock.mockReset()
    routerPushMock.mockReset()
    currentPath = '/ask'
  })

  it('calls getTicketBySorszam with the inspector sorszam', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    expect(getTicketMock).toHaveBeenCalledWith('B26071801')
    wrapper.unmount()
  })

  it('renders status, kategoria, sulyossag, technician from the resolved ticket', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    const meta = findInBody('ticket-details')
    expect(meta?.textContent ?? '').toContain('Nyitott')
    expect(meta?.textContent ?? '').toContain('Vezérlő hiba')
    expect(meta?.textContent ?? '').toContain('magas')
    expect(meta?.textContent ?? '').toContain('KK')
    wrapper.unmount()
  })

  it('renders the customer card with name, address, phone, email', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    const card = findInBody('ticket-details-customer')
    expect(card?.textContent ?? '').toContain('PLASMA-TECH SYSTEMS KFT.')
    expect(card?.textContent ?? '').toContain('6000')
    expect(card?.textContent ?? '').toContain('Budapest, Kossuth u. 1.')
    expect(card?.textContent ?? '').toContain('+36 30 555 1234')
    expect(card?.textContent ?? '').toContain('info@plasma-tech.example')
    wrapper.unmount()
  })

  it('renders the devices list with raw + model + controller + machine_type', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    const dev0 = findInBody('ticket-details-device-0')
    expect(dev0?.textContent ?? '').toContain('DPB-3-40-ATC-1000')
    expect(dev0?.textContent ?? '').toContain('NCT104')
    expect(dev0?.textContent ?? '').toContain('DPB')
    wrapper.unmount()
  })

  it('renders all notes in lifecycle order, bucketed by kind', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails())
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    const notes = findInBody('ticket-details-notes')
    expect(notes?.textContent ?? '').toContain('Bejelentés')
    expect(notes?.textContent ?? '').toContain('Munka')
    // The reported note (kind=reported) and the two work notes are all rendered.
    expect(notes?.textContent ?? '').toContain('PLC nem válaszol')
    expect(notes?.textContent ?? '').toContain('firmware újratelepítve')
    expect(notes?.textContent ?? '').toContain('Próbaüzem sikeres')
    // Authors are shown too.
    expect(notes?.textContent ?? '').toContain('Kovács K.')
    expect(notes?.textContent ?? '').toContain('Nagy B.')
    wrapper.unmount()
  })

  it('shows the empty hint when the API returns 404 (sorszam not found)', async () => {
    getTicketMock.mockRejectedValue({
      status: 404,
      message: 'HTTP 404',
      body: { error: { code: 'not_found', message: "ticket 'B99999999' not found" } },
    })
    const wrapper = mountInspector(makeTicket('B99999999'))
    await flushPromises()
    expect(findInBody('ticket-details-empty')).not.toBeNull()
    wrapper.unmount()
  })

  it('shows the loading skeleton before the data lands', async () => {
    let resolveDetails!: (v: TicketDetails) => void
    getTicketMock.mockReturnValueOnce(new Promise<TicketDetails>((r) => { resolveDetails = r }))
    const wrapper = mountInspector(makeTicket('B26071801'))
    // Synchronously after mount: still loading, no resolved body.
    expect(findInBody('ticket-details-loading')).not.toBeNull()
    expect(findInBody('ticket-details')).toBeNull()
    resolveDetails(makeDetails())
    await flushPromises()
    expect(findInBody('ticket-details')).not.toBeNull()
    wrapper.unmount()
  })

  it('switching to a second ticket refetches WITHOUT closing the sheet', async () => {
    getTicketMock.mockResolvedValueOnce(makeDetails({ sorszam: 'B26071801' }))
    const wrapper = mountInspector(makeTicket('B26071801'))
    await flushPromises()
    expect(findInBody('ticket-inspector')).not.toBeNull()
    expect(getTicketMock).toHaveBeenCalledTimes(1)

    // Second ticket while the sheet is open: same instance, no close,
    // new fetch for the new sorszam.
    getTicketMock.mockResolvedValueOnce(makeDetails({ sorszam: 'B26071802' }))
    await wrapper.setProps({ ticket: makeTicket('B26071802') })
    await flushPromises()
    expect(getTicketMock).toHaveBeenCalledWith('B26071802')
    expect(findInBody('ticket-inspector')).not.toBeNull()
    const sorszam = findInBody('ticket-inspector-sorszam')
    expect(sorszam?.textContent ?? '').toBe('B26071802')
    wrapper.unmount()
  })
})

// Note: The previous "Megnyitás Ask-ban" footer CTA was removed in
// Phase 8 (the user removed those buttons from the inspector footer).
// The CTA's three test cases were retired with it — they asserted
// behaviour that no longer exists. Operators can still open Ask with
// a ticket prefilled by tapping the sorszam link in the body.
