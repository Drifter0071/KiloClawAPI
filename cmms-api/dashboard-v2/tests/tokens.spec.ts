// tests/tokens.spec.ts
//
// Phase 5.5 — Token page redesign (src/routes/TokensPage.vue).
//
// Covers:
//   1. "Tokenek megjelenítése" toggles the management panel; panel
//      renders the 3 prefixes (read / write / bearer). Click again
//      and the panel disappears.
//   2. "Token rotáció részletei" opens an informational dialog
//      with the verbatim 501 note and a Copy button. The copy
//      action uses the clipboard and flashes "Másolva".
//   3. EventBadge uses the data-action / data-tone contract from
//      the grammar (login → success, login_failed → danger,
//      question → info) — color classes are not asserted so a
//      theme refresh can change them freely.
//   4. Row click opens the right-side detail drawer with the
//      expected event-data rows (időpont / művelet / eszköz /
//      felhasználó / részletek) and "—" for missing fields.
//   5. "Több betöltése" bumps api.audit limit from 20 to 40.
//   6. Empty audit → "Nincs megjeleníthető biztonsági esemény."
//   7. Search + group filter + "Szűrők törlése" round-trip:
//      the search narrows the visible rows, the group chip
//      narrows by group, and clear resets both.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { nextTick } from 'vue'
import TokensPage from '../src/routes/TokensPage.vue'
import type { AuditResponse, TokensResponse } from '../src/lib/api'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { tokensMock, auditMock } = vi.hoisted(() => ({
  tokensMock: vi.fn<(limit?: number) => Promise<TokensResponse>>(),
  auditMock: vi.fn<(limit?: number) => Promise<AuditResponse>>(),
}))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ tokens: tokensMock, audit: auditMock }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let wrapper: VueWrapper | null = null

function mountPage(): VueWrapper {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  wrapper = mount(TokensPage, {
    global: {
      plugins: [createPinia(), [VueQueryPlugin, { queryClient }]],
    },
  })
  return wrapper
}

function drawerPanel(): Element | null {
  return document.body.querySelector('[data-testid="responsive-drawer-panel"]')
}

function modalPanel(): Element | null {
  return document.body.querySelector('[data-testid="modal-panel"]')
}

beforeEach(() => {
  tokensMock.mockReset()
  auditMock.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokensPage', () => {
  it('clicking the primary button reveals the 3 token prefixes; clicking again hides', async () => {
    tokensMock.mockResolvedValue({
      read_token_prefix: 'cmms_rea',
      write_token_prefix: 'cmms_wri',
      bearer_token_prefix: 'cmms_bea',
    })
    auditMock.mockResolvedValue({ entries: [] })
    const w = mountPage()
    await flushPromises()

    // Hidden + lazily fetched by default.
    expect(w.find('[data-testid="token-panel"]').exists()).toBe(false)
    expect(tokensMock).not.toHaveBeenCalled()

    await w.get('[data-testid="show-tokens-btn"]').trigger('click')
    await flushPromises()
    await nextTick()

    const panel = w.get('[data-testid="token-panel"]')
    expect(panel.text()).toContain('cmms_rea')
    expect(panel.text()).toContain('cmms_wri')
    expect(panel.text()).toContain('cmms_bea')
    expect(tokensMock).toHaveBeenCalledTimes(1)

    // Toggle back off.
    await w.get('[data-testid="show-tokens-btn"]').trigger('click')
    await nextTick()
    expect(w.find('[data-testid="token-panel"]').exists()).toBe(false)
  })

  it('rotation dialog: 501 note verbatim + Copy instructions copies + flashes', async () => {
    auditMock.mockResolvedValue({ entries: [] })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    const w = mountPage()
    await flushPromises()

    await w.get('[data-testid="rotate-btn"]').trigger('click')
    await nextTick()

    const panel = modalPanel()
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('Token rotáció részletei')
    expect(panel?.textContent).toContain(
      'update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts',
    )

    const copyBtn = panel?.querySelector(
      '[data-testid="copy-instructions-btn"]',
    ) as HTMLButtonElement | null
    expect(copyBtn).not.toBeNull()
    copyBtn?.click()
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(
      'update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts',
    )
    expect(copyBtn?.textContent).toContain('Másolva')

    // Close via the footer button.
    const closeBtn = panel?.querySelector(
      '[data-testid="modal-close-btn"]',
    ) as HTMLButtonElement | null
    closeBtn?.click()
    await nextTick()
    expect(modalPanel()).toBeNull()
  })

  it('event badges use the data-action / data-tone grammar contract', async () => {
    auditMock.mockResolvedValue({
      entries: [
        { t: '2026-08-12T10:00:00.000Z', action: 'login', tool: 'dashboard', user: 'ger' },
        { t: '2026-08-12T10:01:00.000Z', action: 'login_failed', user: 'ger' },
        { t: '2026-08-12T10:02:00.000Z', action: 'question', tool: 'answer', detail: 'M26057 vezérlés' },
      ],
    })
    const w = mountPage()
    await flushPromises()

    const badges = w.findAll('[data-testid="audit-badge"]')
    expect(badges).toHaveLength(3)

    expect(badges[0]?.attributes('data-action')).toBe('login')
    expect(badges[0]?.attributes('data-tone')).toBe('success')
    expect(badges[0]?.text()).toBe('bejelentkezés')

    expect(badges[1]?.attributes('data-action')).toBe('login_failed')
    expect(badges[1]?.attributes('data-tone')).toBe('danger')

    expect(badges[2]?.attributes('data-action')).toBe('question')
    expect(badges[2]?.attributes('data-tone')).toBe('info')
    expect(badges[2]?.text()).toBe('kérdés')
  })

  it('row click opens the right-side detail drawer with event-data rows', async () => {
    auditMock.mockResolvedValue({
      entries: [{ t: '2026-08-12T10:00:00.000Z', action: 'answer', detail: 'found 3 tickets' }],
    })
    const w = mountPage()
    await flushPromises()

    await w.findAll('[data-testid="audit-row"]')[0]?.trigger('click')
    await nextTick()
    await flushPromises()

    const panel = drawerPanel()
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('Audit bejegyzés')
    expect(panel?.querySelectorAll('[data-testid="audit-detail-row"]').length).toBe(4)
    const values = Array.from(
      panel?.querySelectorAll('[data-testid="audit-detail-value"]') ?? [],
    ).map((el) => el.textContent ?? '')
    expect(values).toEqual([
      '2026-08-12T10:00:00.000Z',
      'answer',
      '—',
      '—',
    ])
  })

  it('Load more bumps the api.audit limit arg from 20 to 40', async () => {
    auditMock.mockResolvedValue({
      entries: [{ t: '2026-08-12T10:00:00.000Z', action: 'login' }],
    })
    const w = mountPage()
    await flushPromises()

    expect(auditMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledWith(20)

    await w.get('[data-testid="load-more-btn"]').trigger('click')
    await flushPromises()

    expect(auditMock).toHaveBeenCalledTimes(2)
    expect(auditMock).toHaveBeenLastCalledWith(40)
  })

  it('empty audit log renders the "no events" empty state', async () => {
    auditMock.mockResolvedValue({ entries: [] })
    const w = mountPage()
    await flushPromises()

    const empty = w.find('[data-testid="audit-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('Nincs megjeleníthető biztonsági esemény')
    expect(w.findAll('[data-testid="audit-row"]')).toHaveLength(0)
  })

  it('search + group filter + "Szűrők törlése" round-trip', async () => {
    auditMock.mockResolvedValue({
      entries: [
        { t: '2026-08-12T10:00:00.000Z', action: 'login', user: 'ger', tool: 'dashboard' },
        { t: '2026-08-12T10:01:00.000Z', action: 'login_failed', user: 'ger' },
        { t: '2026-08-12T10:02:00.000Z', action: 'question', user: 'geri', tool: 'answer', detail: 'M26057 vezérlés' },
      ],
    })
    const w = mountPage()
    await flushPromises()

    // 3 rows initially.
    expect(w.findAll('[data-testid="audit-row"]')).toHaveLength(3)

    // Search narrows to "M26057" — only the question row matches.
    const search = w.get('[data-testid="audit-search"]')
    await search.setValue('M26057')
    await nextTick()
    let rows = w.findAll('[data-testid="audit-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('M26057')

    // Clear filters resets the search.
    await w.get('[data-testid="clear-filters-btn"]').trigger('click')
    await nextTick()
    expect(w.findAll('[data-testid="audit-row"]')).toHaveLength(3)

    // Group filter "Hitelesítés" → only `login` (auth group).
    // Note: `login_failed` lives in the "failure" group, not "auth".
    await w.get('[data-testid="group-chip-auth"]').trigger('click')
    await nextTick()
    rows = w.findAll('[data-testid="audit-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('bejelentkezés')

    // "Hiba" group → `login_failed`.
    await w.get('[data-testid="clear-filters-btn"]').trigger('click')
    await nextTick()
    await w.get('[data-testid="group-chip-failure"]').trigger('click')
    await nextTick()
    rows = w.findAll('[data-testid="audit-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('sikertelen bejelentkezés')

    // Clear filters again.
    await w.get('[data-testid="clear-filters-btn"]').trigger('click')
    await nextTick()
    expect(w.findAll('[data-testid="audit-row"]')).toHaveLength(3)
  })
})
