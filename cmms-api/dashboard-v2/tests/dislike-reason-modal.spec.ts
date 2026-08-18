// tests/dislike-reason-modal.spec.ts
//
// The reason modal that opens when the user clicks 👎 while verbose
// dislike is ON.
//
// Coverage:
//   1. Renders 5 fixed reasons + "Other" radio (6 total).
//   2. Submit is disabled until a reason is selected.
//   3. "Other" reveals a textarea (required, max 280 chars).
//   4. Submitting with a fixed reason emits `submitted` with the
//      verbatim reason string.
//   5. Submitting with "Other" + text emits `other:<text>`.
//   6. Submitting with "Other" + empty text is blocked.
//   7. Escape closes the modal (does NOT submit).
//   8. Backdrop click closes the modal.
//   9. Cancel button closes the modal.
//  10. Renders teleported to body, not to the local parent.
//
// Note on testids: the modal is teleported to <body>, so
// `wrapper.get(testid)` won't find it. We use document.body.querySelector
// for the teleported elements (per the VTU + Teleport precedent in
// ticket-inspector-mobile-sheet.spec.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DislikeReasonModal from '@/components/DislikeReasonModal.vue'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

async function mountModal(answerId = 'A1') {
  return mount(DislikeReasonModal, {
    props: { open: true, answerId },
    attachTo: document.body,
  })
}

function inBody(testid: string): Element | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

describe('DislikeReasonModal — structure', () => {
  it('renders 5 fixed reasons plus the "Other" radio', async () => {
    await mountModal()
    const radios = document.body.querySelectorAll('input[type="radio"]')
    expect(radios.length).toBe(6)
  })

  it('renders the Hungarian title', async () => {
    await mountModal()
    expect(inBody('dislike-reason-title')?.textContent).toContain('Mi volt a baj')
  })

  it('teleports to body (not into the local parent)', async () => {
    await mountModal()
    expect(inBody('dislike-reason-modal')).not.toBeNull()
  })

  it('does not render anything when open is false', async () => {
    mount(DislikeReasonModal, { props: { open: false, answerId: 'A1' }, attachTo: document.body })
    await nextTick()
    expect(inBody('dislike-reason-modal')).toBeNull()
  })
})

describe('DislikeReasonModal — submit gating', () => {
  it('Submit is disabled when no reason is selected', async () => {
    await mountModal()
    const btn = inBody('dislike-reason-submit') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Submit is enabled when a fixed reason is selected', async () => {
    await mountModal()
    const radio0 = document.body.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-0"]')!
    radio0.checked = true
    radio0.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const btn = inBody('dislike-reason-submit') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('"Other" reveals the textarea (initially disabled because empty)', async () => {
    await mountModal()
    const other = document.body.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-other"]')!
    other.checked = true
    other.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(inBody('dislike-reason-other-textarea')).not.toBeNull()
    const btn = inBody('dislike-reason-submit') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('"Other" + text enables Submit', async () => {
    await mountModal()
    const other = document.body.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-other"]')!
    other.checked = true
    other.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const ta = inBody('dislike-reason-other-textarea') as HTMLTextAreaElement
    ta.value = 'A válasz nem volt konkrét.'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const btn = inBody('dislike-reason-submit') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})

describe('DislikeReasonModal — submit emits the right reason', () => {
  it('a fixed reason is passed verbatim', async () => {
    const w = await mountModal()
    const radio0 = document.body.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-0"]')!
    radio0.checked = true
    radio0.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    ;(inBody('dislike-reason-submit') as HTMLButtonElement).click()
    const events = w.emitted('submitted') ?? []
    expect(events.length).toBe(1)
    expect(events[0]?.[0]).toBe('wrong customer/device')
  })

  it('"Other" + text emits other:<trimmed-text>', async () => {
    const w = await mountModal()
    const other = document.body.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-other"]')!
    other.checked = true
    other.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const ta = inBody('dislike-reason-other-textarea') as HTMLTextAreaElement
    ta.value = '  A pontos válasz hibás.  '
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(inBody('dislike-reason-submit') as HTMLButtonElement).click()
    const events = w.emitted('submitted') ?? []
    expect(events[0]?.[0]).toBe('other:A pontos válasz hibás.')
  })

  it('"Other" + text over 280 chars is truncated to 280', async () => {
    const w = await mountModal()
    const other = document.body.querySelector<HTMLInputElement>('[data-testid="dislike-reason-radio-other"]')!
    other.checked = true
    other.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const ta = inBody('dislike-reason-other-textarea') as HTMLTextAreaElement
    // The textarea has maxlength=280 so the browser caps it. We can
    // set the value directly, but the emit code also slices — the
    // final emitted reason must be ≤ 280 chars body.
    ta.value = 'x'.repeat(500)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(inBody('dislike-reason-submit') as HTMLButtonElement).click()
    const events = w.emitted('submitted') ?? []
    const reason = (events[0]?.[0] as string) ?? ''
    expect(reason.startsWith('other:')).toBe(true)
    expect(reason.length).toBeLessThanOrEqual('other:'.length + 280)
  })
})

describe('DislikeReasonModal — close paths', () => {
  it('Cancel button closes (emits update:open false)', async () => {
    const w = await mountModal()
    ;(inBody('dislike-reason-cancel') as HTMLButtonElement).click()
    const events = w.emitted('update:open') ?? []
    expect(events[events.length - 1]?.[0]).toBe(false)
  })

  it('Escape closes', async () => {
    const w = await mountModal()
    const backdrop = inBody('dislike-reason-backdrop') as HTMLElement
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    const events = w.emitted('update:open') ?? []
    expect(events[events.length - 1]?.[0]).toBe(false)
  })

  it('backdrop click closes; inner click does NOT', async () => {
    const w = await mountModal()
    const inner = inBody('dislike-reason-modal') as HTMLElement
    // Inner click — must NOT close
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    let events = w.emitted('update:open') ?? []
    expect(events.length).toBe(0)
    // Backdrop click — must close
    const backdrop = inBody('dislike-reason-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    events = w.emitted('update:open') ?? []
    expect(events[events.length - 1]?.[0]).toBe(false)
  })

  it('Escape / backdrop / cancel do NOT emit `submitted`', async () => {
    const w = await mountModal()
    const backdrop = inBody('dislike-reason-backdrop') as HTMLElement
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    ;(inBody('dislike-reason-cancel') as HTMLButtonElement).click()
    expect(w.emitted('submitted') ?? []).toHaveLength(0)
  })
})
