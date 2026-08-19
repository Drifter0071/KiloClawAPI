// tests/dislike-correction.spec.ts
//
// Two related components:
//
//   1. DislikeReasonModal — the existing reason modal. Just the 5
//      reasons + "Other" branch; emits a `reason: string`.
//   2. CorrectionModal — the new standalone modal. Single 1000-char
//      textarea; emits `submitted(correction: string)`.
//
// Both use <Teleport to="body">, so we look up the testid'd nodes
// via document.querySelector (matching the pattern in
// tests/atoms-overlay.spec.ts) — `wrapper.find('[data-testid="…"]')`
// does NOT traverse into teleported content.

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import DislikeReasonModal from '../src/components/DislikeReasonModal.vue'
import CorrectionModal from '../src/components/CorrectionModal.vue'

function $tid(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null
}
function $tids(sel: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(sel)) as HTMLElement[]
}

function mountReason() {
  document.body.innerHTML = ''
  return mount(DislikeReasonModal, {
    props: { open: true, answerId: '01HREASONTEST00000000000' },
    attachTo: document.body,
  })
}

function mountCorrection(busy = false) {
  document.body.innerHTML = ''
  return mount(CorrectionModal, {
    props: { open: true, answerId: '01HCORRECTEST00000000000', busy },
    attachTo: document.body,
  })
}

describe('DislikeReasonModal', () => {
  it('renders 5 fixed reasons with the expected wire values', () => {
    mountReason()
    const expected = [
      'wrong customer/device',
      'wrong data (number/date/count)',
      'missed relevant ticket(s)',
      'made something up',
      'wording/format only',
    ]
    for (let i = 0; i < expected.length; i++) {
      const radio = $tid(`[data-testid="dislike-reason-radio-${i}"]`) as HTMLInputElement
      expect(radio).toBeTruthy()
      expect(radio.value).toBe(expected[i])
    }
  })

  it('emits the reason string verbatim for a fixed reason', async () => {
    const w = mountReason()
    ;($tid('[data-testid="dislike-reason-radio-0"]') as HTMLInputElement).click()
    await nextTick()
    ;($tid('[data-testid="dislike-reason-submit"]') as HTMLButtonElement).click()
    await nextTick()
    const submitted = w.emitted('submitted')!
    expect(submitted[0][0]).toBe('wrong customer/device')
  })

  it('requires non-empty "Other" text and emits "other:<text>"', async () => {
    const w = mountReason()
    ;($tid('[data-testid="dislike-reason-radio-other"]') as HTMLInputElement).click()
    await nextTick()
    const submit = $tid('[data-testid="dislike-reason-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const ta = $tid('[data-testid="dislike-reason-other-textarea"]') as HTMLTextAreaElement
    ta.value = 'Saját ok'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(submit.disabled).toBe(false)
    submit.click()
    await nextTick()
    expect(w.emitted('submitted')![0][0]).toBe('other:Saját ok')
  })

  it('slices "Other" text to 280 chars', async () => {
    const w = mountReason()
    ;($tid('[data-testid="dislike-reason-radio-other"]') as HTMLInputElement).click()
    await nextTick()
    const ta = $tid('[data-testid="dislike-reason-other-textarea"]') as HTMLTextAreaElement
    ta.value = 'A'.repeat(500)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;($tid('[data-testid="dislike-reason-submit"]') as HTMLButtonElement).click()
    await nextTick()
    const emitted = w.emitted('submitted')![0][0] as string
    expect(emitted.startsWith('other:')).toBe(true)
    expect(emitted.length).toBeLessThanOrEqual('other:'.length + 280)
  })

  it('blocks submit when no reason is picked', async () => {
    const w = mountReason()
    const submit = $tid('[data-testid="dislike-reason-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    submit.click()
    await nextTick()
    expect(w.emitted('submitted')).toBeFalsy()
  })
})

describe('CorrectionModal', () => {
  it('renders the textarea with a 0/1000 counter and disabled submit', () => {
    mountCorrection()
    const ta = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    expect(ta).toBeTruthy()
    expect(ta.maxLength).toBe(1000)
    const modal = $tid('[data-testid="correction-modal"]') as HTMLElement
    expect(modal.textContent).toContain('0 / 1000')
    const submit = $tid('[data-testid="correction-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('updates the counter as the user types', async () => {
    mountCorrection()
    const ta = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    ta.value = 'A helyes ügyfél ACME Kft.'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const modal = $tid('[data-testid="correction-modal"]') as HTMLElement
    expect(modal.textContent).toMatch(/\b25\b\s*\/\s*1000/)
  })

  it('enables submit when the textarea has non-whitespace content', async () => {
    mountCorrection()
    const ta = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    ta.value = '   '
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const submit = $tid('[data-testid="correction-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    ta.value = 'A helyes válasz'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(submit.disabled).toBe(false)
  })

  it('emits the trimmed correction on submit', async () => {
    const w = mountCorrection()
    const ta = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    ta.value = '   A helyes: 42 ticket, nem 41.   '
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;($tid('[data-testid="correction-submit"]') as HTMLButtonElement).click()
    await nextTick()
    expect(w.emitted('submitted')![0][0]).toBe('A helyes: 42 ticket, nem 41.')
  })

  it('slices the correction to 1000 chars on submit', async () => {
    const w = mountCorrection()
    const ta = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    ta.value = 'A'.repeat(1500)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    // happy-dom doesn't enforce maxlength on programmatic value
    // assignment; the cap is applied at submit time. The
    // <textarea> has maxlength="1000" so a real browser (or
    // Playwright) would also cap typing — covered separately.
    ;($tid('[data-testid="correction-submit"]') as HTMLButtonElement).click()
    await nextTick()
    const emitted = w.emitted('submitted')![0][0] as string
    expect(emitted.length).toBe(1000)
  })

  it('disables cancel + submit while busy', () => {
    mountCorrection(true)
    const cancel = $tid('[data-testid="correction-cancel"]') as HTMLButtonElement
    const submit = $tid('[data-testid="correction-submit"]') as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    expect(submit.disabled).toBe(true)
  })

  it('resets the textarea when the modal is closed and reopened', async () => {
    const w = mountCorrection()
    const ta = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    ta.value = 'első'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;($tid('[data-testid="correction-cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    await w.setProps({ open: false })
    await nextTick()
    await w.setProps({ open: true })
    await nextTick()
    const ta2 = $tid('[data-testid="correction-textarea"]') as HTMLTextAreaElement
    expect(ta2.value).toBe('')
    const modal = $tid('[data-testid="correction-modal"]') as HTMLElement
    expect(modal.textContent).toContain('0 / 1000')
  })

  it('emits update:open(false) when backdrop is clicked', async () => {
    const w = mountCorrection()
    const backdrop = $tid('[data-testid="correction-backdrop"]') as HTMLElement
    backdrop.dispatchEvent(new Event('click', { bubbles: true }))
    await nextTick()
    expect(w.emitted('update:open')![0][0]).toBe(false)
  })
})

// Suppress an unused-import warning if vitest strips the helper.
void $tids
