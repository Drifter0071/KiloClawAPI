// tests/tokens.spec.ts
//
// Phase 5.5 — Token Portal page (src/routes/TokensPage.vue).
//
// Covers:
//   1. Show current tokens → panel renders the 3 prefixes (toggle hides).
//   2. Rotate dialog: 501 note verbatim + Copy instructions (clipboard
//      mock) with the flash state.
//   3. Audit table: spec badge classes (login emerald / logout slate /
//      login_failed rose / question sky) + formatted time cell.
//   4. Row click → audit-entry modal with 5 key/value rows and '—' for
//      missing optional fields.
//   5. Load more bumps the api.audit limit arg (20 → 40).
//   6. Empty entries → "No audit entries yet".
//
// The page's queries run through withAutoRetry(), which touches the
// Pinia api-state store — so every mount installs a fresh Pinia plus a
// fresh QueryClient via VueQueryPlugin.

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

/** The Modal renders via Teleport → content lives in document.body. */
function bodyPanel(): Element | null {
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
  it('clicking Show renders the 3 token prefixes; clicking again hides', async () => {
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
    expect(panel.text()).toContain('Read')
    expect(panel.text()).toContain('Write')
    expect(panel.text()).toContain('Bearer')
    expect(tokensMock).toHaveBeenCalledTimes(1)

    // Toggle back off.
    await w.get('[data-testid="show-tokens-btn"]').trigger('click')
    await nextTick()
    expect(w.find('[data-testid="token-panel"]').exists()).toBe(false)
  })

  it('Rotate opens the dialog with the 501 note; Copy instructions copies + flashes', async () => {
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

    const panel = bodyPanel()
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('Read token rotáció')
    expect(panel?.textContent).toContain('A szerver-oldali rotáció még nincs bekötve')
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
    expect(bodyPanel()).toBeNull()
  })

  it('audit table renders rows with spec badge colors and formatted times', async () => {
    auditMock.mockResolvedValue({
      entries: [
        { t: '2026-08-12T10:00:00.000Z', action: 'login', tool: 'dashboard', user: 'ger' },
        { t: '2026-08-12T10:00:30.000Z', action: 'logout', user: 'ger' },
        { t: '2026-08-12T10:01:00.000Z', action: 'login_failed', user: 'ger' },
        { t: '2026-08-12T10:02:00.000Z', action: 'question', tool: 'answer', detail: 'M26057 vezérlés' },
      ],
    })
    const w = mountPage()
    await flushPromises()

    const badges = w.findAll('[data-testid="audit-badge"]')
    expect(badges).toHaveLength(4)

    expect(badges[0]?.classes()).toContain('bg-emerald-500/15')
    expect(badges[0]?.classes()).toContain('text-emerald-300')
    expect(badges[0]?.text()).toBe('bejelentkezés')

    expect(badges[1]?.classes()).toContain('bg-slate-500/15')
    expect(badges[1]?.classes()).toContain('text-slate-300')

    expect(badges[2]?.classes()).toContain('bg-rose-500/15')
    expect(badges[2]?.classes()).toContain('text-rose-300')

    expect(badges[3]?.classes()).toContain('bg-sky-500/15')
    expect(badges[3]?.classes()).toContain('text-sky-300')
    expect(badges[3]?.text()).toBe('kérdés')

    // Time cell: 'YYYY-MM-DD HH:MM:SS' in the local timezone.
    const d = new Date('2026-08-12T10:00:00.000Z')
    const pad = (n: number) => String(n).padStart(2, '0')
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    expect(w.findAll('[data-testid="audit-time"]')[0]?.text()).toBe(expected)
  })

  it('row click opens the audit modal with 5 key/value rows and em-dashes for missing fields', async () => {
    auditMock.mockResolvedValue({
      entries: [{ t: '2026-08-12T10:00:00.000Z', action: 'answer', detail: 'found 3 tickets' }],
    })
    const w = mountPage()
    await flushPromises()

    await w.findAll('[data-testid="audit-row"]')[0]?.trigger('click')
    await nextTick()

    const panel = bodyPanel()
    expect(panel?.textContent).toContain('Audit bejegyzés')
    expect(panel?.querySelectorAll('[data-testid="audit-detail-row"]').length).toBe(5)
    const values = Array.from(
      panel?.querySelectorAll('[data-testid="audit-detail-value"]') ?? [],
    ).map((el) => el.textContent ?? '')
    expect(values).toEqual([
      '2026-08-12T10:00:00.000Z',
      'answer',
      '—',
      '—',
      'found 3 tickets',
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

  it('empty audit log renders the "No audit entries yet" row', async () => {
    auditMock.mockResolvedValue({ entries: [] })
    const w = mountPage()
    await flushPromises()

    const empty = w.find('[data-testid="audit-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('Még nincs audit bejegyzés')
    expect(w.findAll('[data-testid="audit-row"]')).toHaveLength(0)
  })
})
