// tests/disliked-answers-page.spec.ts
//
// Admin-only master/detail view of every disliked Ask answer.
//
// Coverage:
//   1. Renders the list with one row per item, including the
//      question, customer, model, vote reason, and timestamp.
//   2. The total counter shows the API-reported total.
//   3. Clicking a row opens the teleported detail drawer with the
//      full payload (final_text, ticket cards, tool trace, reason).
//   4. The drawer is in document.body (Teleport).
//   5. The close button (X) dismisses the drawer.
//   6. The backdrop click dismisses the drawer.
//   7. Body scroll is locked while the drawer is open and released
//      on close.
//   8. "Több betöltése" appends the next page to the list.
//   9. Empty list (no dislikes) shows the "Még nincs" notice.
//  10. 401 from /disliked routes to /admin/login (admin auth lost).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import DislikedAnswersPage from '@/routes/DislikedAnswersPage.vue'
import type { DislikedItem, DislikedListResponse } from '@/composables/useAdminFeedback'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loadDislikedMock, pushMock } = vi.hoisted(() => ({
  loadDislikedMock: vi.fn(),
  pushMock: vi.fn(),
}))

vi.mock('@/composables/useAdminFeedback', () => ({
  useAdminFeedback: () => ({
    loadFeedbackCounters: vi.fn().mockResolvedValue({ likes: 10, dislikes: 2 }),
    loadDisliked: loadDislikedMock,
    loadSettings: vi.fn().mockResolvedValue({ verbose_dislike: false }),
    saveSettings: vi.fn(),
  }),
  AdminAuthError: class extends Error {},
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock, currentRoute: { value: { path: '/admin/disliked' } } }),
  useRoute: () => ({ params: {}, query: {} }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  loadDislikedMock.mockReset()
  pushMock.mockReset()
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

function item(id: string, overrides: Partial<DislikedItem> = {}): DislikedItem {
  return {
    answer_id: id,
    q: `M26057 kérdés ${id}?`,
    final_text: `Ez a ${id} snapshot szövege.`,
    tool_trace: [
      { name: 'answer_question', args: { q: 'x' }, ok: true },
      { name: 'get_ticket_by_sorszam', args: { sorszam: 'B2408001' }, ok: true },
    ],
    model: 'openai/gpt-4o',
    iterations: 2,
    language: 'hu',
    resolved_customer: 'ANDRITZ KFT.',
    ticket_cards: [
      { sorszam: 'B2408001', customer_name: 'ANDRITZ KFT.', status: 'open', snippet: 'X hajtás modul csere.', device: 'M26057', kategoria: 'Hardver hiba', kategoria_inferred: null, sulyossag_inferred: 'magas', reported_at_iso: '2026-07-22T10:00:00Z' },
    ],
    created_at: '2026-08-15T10:00:00Z',
    vote: { uid: 'u1', vote: -1, reason: 'wrong data (number/date/count)', created_at: '2026-08-15T10:01:00Z' },
    ...overrides,
  }
}

function page(items: DislikedItem[], total = items.length, more = false) {
  return { items, total, limit: 50, offset: more ? items.length : items.length }
}

async function mountPage() {
  return mount(DislikedAnswersPage, { attachTo: document.body })
}

function inBody(testid: string): Element | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

describe('DislikedAnswersPage — list', () => {
  it('renders one row per item, with the question + customer + model + reason', async () => {
    loadDislikedMock.mockResolvedValueOnce(page([item('a1'), item('a2', { resolved_customer: 'MÁV Zrt.', q: 'kritikus?' })]))
    const w = await mountPage()
    await flushPromises()
    expect(inBody('disliked-answers-row-a1')).not.toBeNull()
    expect(inBody('disliked-answers-row-a2')).not.toBeNull()
    const a1 = inBody('disliked-answers-row-a1') as HTMLElement
    expect(a1.textContent).toContain('ANDRITZ')
    expect(a1.textContent).toContain('gpt-4o')
    expect(a1.textContent).toContain('2 lépés')
    expect(a1.textContent).toContain('Hibás adat')
  })

  it('shows the API-reported total', async () => {
    loadDislikedMock.mockResolvedValueOnce(page([item('a1'), item('a2')], 7))
    const w = await mountPage()
    await flushPromises()
    expect(inBody('disliked-answers-total')?.textContent).toContain('7')
  })

  it('shows the empty-state when there are no dislikes', async () => {
    loadDislikedMock.mockResolvedValueOnce(page([], 0))
    const w = await mountPage()
    await flushPromises()
    expect(inBody('disliked-answers-empty')).not.toBeNull()
  })

  it('"Több betöltése" appends the next page', async () => {
    const first = [item('a1'), item('a2'), item('a3')]
    const second = [item('a4'), item('a5')]
    loadDislikedMock
      .mockResolvedValueOnce({ items: first, total: 5, limit: 50, offset: 3 })
      .mockResolvedValueOnce({ items: second, total: 5, limit: 50, offset: 5 })
    const w = await mountPage()
    await flushPromises()
    expect(inBody('disliked-answers-row-a1')).not.toBeNull()
    expect(inBody('disliked-answers-row-a3')).not.toBeNull()
    expect(inBody('disliked-answers-row-a4')).toBeNull()
    await (inBody('disliked-answers-load-more') as HTMLButtonElement).click()
    await flushPromises()
    expect(inBody('disliked-answers-row-a4')).not.toBeNull()
    expect(inBody('disliked-answers-row-a5')).not.toBeNull()
  })
})

describe('DislikedAnswersPage — detail drawer', () => {
  it('opens teleported to body on row click, with the full payload', async () => {
    loadDislikedMock.mockResolvedValueOnce(page([item('a1')]))
    const w = await mountPage()
    await flushPromises()
    ;(inBody('disliked-answers-row-a1') as HTMLButtonElement).click()
    await flushPromises()
    const drawer = inBody('disliked-answers-drawer')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).toContain('Ez a a1 snapshot szövege.')
    expect(drawer?.textContent).toContain('Hibás adat')
    expect(drawer?.textContent).toContain('B2408001')
    expect(drawer?.textContent).toContain('answer_question')
    expect(drawer?.textContent).toContain('a1')
  })

  it('close button dismisses the drawer', async () => {
    loadDislikedMock.mockResolvedValueOnce(page([item('a1')]))
    const w = await mountPage()
    await flushPromises()
    ;(inBody('disliked-answers-row-a1') as HTMLButtonElement).click()
    await flushPromises()
    expect(inBody('disliked-answers-drawer')).not.toBeNull()
    ;(inBody('disliked-answers-drawer-close') as HTMLButtonElement).click()
    await flushPromises()
    expect(inBody('disliked-answers-drawer')).toBeNull()
  })

  it('backdrop click dismisses the drawer', async () => {
    loadDislikedMock.mockResolvedValueOnce(page([item('a1')]))
    const w = await mountPage()
    await flushPromises()
    ;(inBody('disliked-answers-row-a1') as HTMLButtonElement).click()
    await flushPromises()
    expect(inBody('disliked-answers-drawer')).not.toBeNull()
    ;(inBody('disliked-answers-backdrop') as HTMLElement).click()
    await flushPromises()
    expect(inBody('disliked-answers-drawer')).toBeNull()
  })

  it('locks body scroll while open and releases on close', async () => {
    // Save whatever the test env had on body.style.overflow (the
    // happy-dom default is empty; a previous test may have left
    // something behind, so we restore it on close).
    const original = document.body.style.overflow
    loadDislikedMock.mockResolvedValueOnce(page([item('a1')]))
    const w = await mountPage()
    await flushPromises()
    ;(inBody('disliked-answers-row-a1') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.body.style.overflow).toBe('hidden')
    ;(inBody('disliked-answers-drawer-close') as HTMLButtonElement).click()
    await flushPromises()
    // After close, the body is restored to whatever it was BEFORE the
    // drawer opened — not necessarily the empty string. The spec
    // contract is: closed → not 'hidden'.
    expect(document.body.style.overflow).not.toBe('hidden')
    document.body.style.overflow = original
  })
})

describe('DislikedAnswersPage — 401 → /admin/login', () => {
  it('routes to /admin/login when the load returns 401', async () => {
    // We construct a real AdminAuthError and verify the page catches it.
    const { AdminAuthError } = await import('@/composables/useAdminFeedback')
    loadDislikedMock.mockRejectedValueOnce(new AdminAuthError('admin_not_authenticated'))
    const w = await mountPage()
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith('/admin/login')
  })
})
