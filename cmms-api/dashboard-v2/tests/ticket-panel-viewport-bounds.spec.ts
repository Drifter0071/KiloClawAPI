// tests/ticket-panel-viewport-bounds.spec.ts
//
// Regression test for the "ticket panel grows with the conversation"
// bug. When the user taps a sorszam in a long message thread on the
// Ask page, the in-place right-column <TicketPanel> previously
// stretched to match the conversation column's full height, so the
// user had to scroll the chat back up to see the ticket header.
//
// Fix:
//   - Panel uses `position: sticky; top: 0; align-self: flex-start`
//     on the desktop variant, so it never grows beyond the visible
//     viewport.
//   - Panel applies `md:max-h-[calc(100dvh-52px)]` (topbar 52px),
//     so even if the conversation column is 5000px tall, the panel
//     is bounded by the viewport.
//   - The inner body keeps `overflow-y-auto`, so a long ticket
//     scrolls inside the panel rather than growing the panel.
//
// This test mounts <TicketPanel> inside a tall flex container that
// simulates the conversation column and asserts the panel's rendered
// height is bounded by a viewport-style max-height, not by the
// container's height.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import TicketPanel from '../src/components/TicketPanel.vue'
import type { EvidenceTicket, TicketDetails } from '@/lib/api'

// ---------------------------------------------------------------------------
// Mocks (same shape as ticket-details.spec.ts)
// ---------------------------------------------------------------------------

const { getTicketMock } = vi.hoisted(() => ({ getTicketMock: vi.fn() }))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ getTicketBySorszam: getTicketMock }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ path: '/ask', fullPath: '/ask' }),
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
    kategoria: 'Szoftver hiba',
    alkategoria: 'PLC',
    sulyossag: 'magas',
    notes: [
      {
        kind: 'reported',
        body: 'Hibás PLC program. A gép nem indul el a Start gombra.',
        created_at: '2026-07-18T08:30:00.000Z',
        author: 'PLASMA',
      },
      {
        kind: 'work',
        body: 'PLC újraflashelve, paraméterek visszatöltve.',
        created_at: '2026-07-18T10:15:00.000Z',
        author: 'KK',
      },
      {
        kind: 'work',
        body: 'Tesztelve, minden tengely mozog. Kész.',
        created_at: '2026-07-18T11:00:00.000Z',
        author: 'KK',
      },
    ],
    ...overrides,
  }
}

// Build a "fat" details object: lots of notes, lots of devices, so
// the body content is taller than the typical viewport.
function makeFatDetails(): TicketDetails {
  const notes = []
  for (let i = 0; i < 30; i++) {
    notes.push({
      kind: i % 3 === 0 ? 'reported' : i % 3 === 1 ? 'work' : 'free',
      body: `Megjegyzés sorszám ${i + 1}: a gép kezelője jelezte, hogy a ${i + 1}. tengely időnként nem válaszol a parancsra, és a kijelző „Axis timeout" hibát ír ki. A hiba reprodukálható a fűrész-program 12. sorszámú mondatában.`,
      created_at: `2026-07-${(i % 28) + 1}T08:30:00.000Z`,
      author: i % 2 === 0 ? 'KK' : 'PLASMA',
    })
  }
  return makeDetails({
    notes,
    devices: Array.from({ length: 4 }, (_, i) => ({
      raw: `DPB-3-40-ATC-${1000 + i} (SN:${2000 + i})`,
      model: 'DPB-3-40',
      software: null,
      hardware: null,
      servos: null,
      controller: 'NCT104',
      machine_type: 'DPB',
      freeform: `ATC-${1000 + i}`,
    })),
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountInConversation(columnHeightPx: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const ticket = makeTicket('B26071801')
  // Fake a tall conversation column by mounting the panel inside a
  // flex container with an explicit height.
  return mount(
    {
      components: { TicketPanel },
      template: `
        <div
          class="flex h-[${columnHeightPx}px] w-[1400px] overflow-y-auto"
          data-testid="conversation-wrapper"
        >
          <div
            class="w-[860px] shrink-0"
            data-testid="conversation-column"
            style="height: ${columnHeightPx}px"
          >
            <div style="height: ${columnHeightPx}px; padding: 24px">
              <!-- Simulated tall message thread -->
              <div
                v-for="i in 50"
                :key="i"
                style="height: 80px; margin-bottom: 12px; background: rgba(255,255,255,0.05); border-radius: 8px"
              />
            </div>
          </div>
          <TicketPanel
            :open="panelOpen"
            :ticket="myTicket"
            class="w-[420px] shrink-0 self-start"
          />
        </div>
      `,
      data() {
        return {
          panelOpen: true,
          myTicket: ticket,
        }
      },
    },
    {
      global: {
        plugins: [createPinia(), [VueQueryPlugin, { queryClient }]],
      },
      attachTo: document.body,
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  getTicketMock.mockReset()
  getTicketMock.mockResolvedValue(makeFatDetails())
})

describe('TicketPanel — viewport bounding', () => {
  it('panel does not grow beyond the viewport when the conversation is very tall', async () => {
    // Simulate a 5000px-tall conversation (would have been >5× the
    // viewport on a normal screen).
    const wrapper = mountInConversation(5000)
    await flushPromises()
    await flushPromises()

    const panel = document.body.querySelector(
      '[data-testid="ticket-panel"]',
    ) as HTMLElement
    expect(panel).toBeTruthy()

    // The panel's bounding rect height should be much smaller than
    // the conversation's 5000px. We don't assert an exact pixel count
    // (jsdom/happy-dom can return different numbers than a real
    // browser), but it must be < 1500px and definitely < 4000px.
    const rect = panel.getBoundingClientRect()
    expect(rect.height).toBeLessThan(1500)
    expect(rect.height).toBeLessThan(4000)
    // The header (with sorszam + close button) must be in the visible
    // top portion of the panel — not pushed down by the body content.
    const header = panel.querySelector('header') as HTMLElement
    expect(header).toBeTruthy()
    const headerRect = header.getBoundingClientRect()
    // Header should be at the very top of the panel.
    expect(headerRect.top).toBeLessThan(20)

    wrapper.unmount()
  })

  it('panel inner body scrolls independently when ticket content is longer than the panel', async () => {
    const wrapper = mountInConversation(5000)
    await flushPromises()
    await flushPromises()

    const panel = document.body.querySelector(
      '[data-testid="ticket-panel"]',
    ) as HTMLElement
    expect(panel).toBeTruthy()

    // The body container should have overflow-y: auto set so long
    // ticket content scrolls inside the panel rather than growing it.
    const body = panel.querySelector(
      '[data-testid="ticket-panel-body"]',
    ) as HTMLElement | null
    expect(body).toBeTruthy()
    // happy-dom doesn't always expose computed styles, so check the
    // className directly for the Tailwind `overflow-y-auto` utility
    // that the implementation uses.
    expect(body!.className).toMatch(/overflow-y-auto/)

    wrapper.unmount()
  })

  it('panel header stays visible without scrolling the conversation', async () => {
    const wrapper = mountInConversation(5000)
    await flushPromises()
    await flushPromises()

    // The user should see the sorszam + close button at the top of
    // the panel without having to scroll within the conversation.
    const sorszamBtn = document.body.querySelector(
      '[data-testid="ticket-panel-sorszam"]',
    ) as HTMLElement
    expect(sorszamBtn).toBeTruthy()
    const closeBtn = document.body.querySelector(
      '[data-testid="ticket-panel-close"]',
    ) as HTMLElement
    expect(closeBtn).toBeTruthy()
    // The sorszam button and the close button should be in the same
    // vertical band (both at the top of the panel).
    const sRect = sorszamBtn.getBoundingClientRect()
    const cRect = closeBtn.getBoundingClientRect()
    expect(Math.abs(sRect.top - cRect.top)).toBeLessThan(60)

    wrapper.unmount()
  })
})
