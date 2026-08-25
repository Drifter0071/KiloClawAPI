// tests/photo-ask-sheet.spec.ts
//
// Component tests for the reworked PhotoAskSheet (photo-to-ask,
// sentence-builder edition, 2026-08-24).
//
// Coverage:
//   1. open=false renders nothing; teleports to body.
//   2. Capture stage: step guide + ONE camera CTA; NO gallery button;
//      input carries capture="environment".
//   3. After shooting: CROP stage first (Pack 1 A6); skipping it runs
//      the cascade; after OCR: build stage shows extracted chips, an
//      EMPTY draft (nothing auto-composed — no "[Gép: …]" template
//      ever), and a low-confidence caution when confidence < 0.5.
//   4. Tapping chips appends to the draft with single-space joins;
//      free typing between taps works; used chips are marked.
//   5. Clear button empties the draft.
//   6. Submit emits the composed question + closes (AskPage wiring).
//   7. Submit is disabled while the draft is empty.
//   8. Empty OCR result shows the explicit empty state; retake goes
//      back to capture; "Inkább diktálom" emits dictate + closes
//      (Pack 1 D3 voice fallback).
//   9. Variant picker (Pack 1 B10): unreliable read + available
//      preprocessed variants -> human picks one -> final OCR pass.
//
// ocrSerial is mocked (Tesseract.js must not load); extractDetails
// from lib/ocrTokens runs for real so chip content is genuine.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  recognize: vi.fn(),
  cascade: vi.fn(),
}))

vi.mock('@/lib/ocrSerial', () => ({
  recognizeSerialFromImage: mocks.recognize,
  runOcrCascade: mocks.cascade,
  releaseVariants: vi.fn(),
}))

import PhotoAskSheet from '@/components/PhotoAskSheet.vue'

beforeAll(() => {
  // happy-dom may lack blob URL support — provide no-op stubs.
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => 'blob:mock',
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: () => {},
      configurable: true,
      writable: true,
    })
  }
})

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.recognize.mockReset()
  mocks.cascade.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

function inBody(testid: string): Element | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function allInBody(testid: string): Element[] {
  return Array.from(document.body.querySelectorAll(`[data-testid="${testid}"]`))
}

async function mountSheet(open = true) {
  const wrapper = mount(PhotoAskSheet, {
    props: { open },
    attachTo: document.body,
  })
  await nextTick()
  return wrapper
}

/** Simulate picking/shooting a file through the hidden input. */
async function pickFile() {
  const input = inBody('photo-ask-input') as HTMLInputElement
  expect(input).not.toBeNull()
  const file = new File(['jpegbytes'], 'plate.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flushPromises()
  await nextTick()
}

/** Shoot + skip cropping so tests reach the OCR pipeline. */
async function shoot() {
  await pickFile()
  const skip = inBody('photo-ask-crop-skip') as HTMLButtonElement
  expect(skip).not.toBeNull()
  skip.click()
  await flushPromises()
  await nextTick()
}

const PLATE_TEXT = 'NCT-99 SN:M-26057 Gyartas: 2026.08.24. 3,5kW'

describe('PhotoAskSheet — structure', () => {
  it('renders nothing when closed', async () => {
    await mountSheet(false)
    expect(inBody('photo-ask-sheet')).toBeNull()
  })

  it('teleports to body when open', async () => {
    await mountSheet(true)
    expect(inBody('photo-ask-sheet')).not.toBeNull()
  })

  it('capture stage shows the step guide and exactly one camera CTA', async () => {
    await mountSheet(true)
    expect(inBody('photo-ask-steps')).not.toBeNull()
    expect(inBody('photo-ask-snap')).not.toBeNull()
    const snapButtons = allInBody('photo-ask-snap')
    expect(snapButtons.length).toBe(1)
  })

  it('has NO gallery button anywhere (camera is the whole feature)', async () => {
    await mountSheet(true)
    expect(document.body.textContent).not.toContain('Galéria')
    expect(allInBody('photo-ask-pick').length).toBe(0)
  })

  it('camera input carries capture=environment', async () => {
    await mountSheet(true)
    const input = inBody('photo-ask-input') as HTMLInputElement
    expect(input.getAttribute('capture')).toBe('environment')
  })
})

describe('PhotoAskSheet — build stage after OCR', () => {
  beforeEach(() => {
    // 0.42 confidence IS an unreliable read per the cascade contract
    // (needsPicker = conf < 0.5), but with no preprocessed variants
    // available there is nothing to pick — so it falls to build with
    // the caution line showing.
    mocks.cascade.mockResolvedValue({
      best: { text: PLATE_TEXT, confidence: 0.42, serial: null, candidates: [] },
      bestLabel: 'original',
      needsPicker: true,
      variants: [],
    })
  })

  it('moves to build stage with chips but an EMPTY draft', async () => {
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-draft')).not.toBeNull()
    const draft = inBody('photo-ask-draft') as HTMLTextAreaElement
    expect(draft.value).toBe('')
  })

  it('NEVER auto-composes a question (the "2026 machine" regression)', async () => {
    await mountSheet(true)
    await shoot()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('[Gép')
    expect(text).not.toContain('Kérem a gép előéletét')
  })

  it('offers the M-id as an identifier chip and keeps the date as a plain word chip', async () => {
    await mountSheet(true)
    await shoot()
    const chips = allInBody('photo-ask-chip').map((el) => el.textContent?.trim())
    expect(chips).toContain('M-26057')
    expect(chips).toContain('2026.08.24')
    // The date must NOT be promoted into the "Azonosítónak tűnik" group.
    const dateChip = allInBody('photo-ask-chip').find((el) =>
      el.textContent?.trim() === '2026.08.24',
    )
    expect(dateChip).toBeDefined()
    const idGroupHeader = Array.from(document.body.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('Azonosítónak tűnik'),
    )
    expect(idGroupHeader).toBeDefined()
    // The date chip lives in the words container, not adjacent to the ids header.
    const wordsContainer = dateChip!.closest('[data-testid="photo-ask-chips"]')
    expect(wordsContainer).not.toBeNull()
    expect(wordsContainer!.contains(dateChip!)).toBe(true)
  })

  it('shows the low-confidence caution when confidence < 0.5', async () => {
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-low-confidence')).not.toBeNull()
  })

  it('hides the low-confidence caution when confidence is high', async () => {
    mocks.cascade.mockResolvedValue({
      best: { text: PLATE_TEXT, confidence: 0.93, serial: null, candidates: [] },
      bestLabel: 'original',
      needsPicker: false,
      variants: [],
    })
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-low-confidence')).toBeNull()
  })

  it('tapping chips appends them space-separated; typing between taps works', async () => {
    await mountSheet(true)
    await shoot()

    const draftInput = () => inBody('photo-ask-draft') as HTMLTextAreaElement

    const chipByText = (t: string): HTMLButtonElement | undefined =>
      allInBody('photo-ask-chip').find(
        (el) => el.textContent?.trim() === t,
      ) as HTMLButtonElement | undefined

    // Tap two chips back to back -> joined with one space.
    chipByText('M-26057')!.click()
    await nextTick()
    chipByText('2026.08.24')!.click()
    await nextTick()
    expect(draftInput().value).toBe('M-26057 2026.08.24')

    // Technician types freely in between…
    const setDraft = (v: string) => {
      const evt = new Event('input')
      // Event.target is a prototype getter — shadow it per-instance
      // (strict-mode assignment would throw).
      Object.defineProperty(evt, 'target', { value: draftInput(), configurable: true })
      draftInput().value = v
      draftInput().dispatchEvent(evt)
    }
    setDraft('Mi történt a géppel 2026.08.24')
    await nextTick()

    // …then appends another extracted detail.
    chipByText('NCT-99')!.click()
    await nextTick()
    expect(draftInput().value).toBe('Mi történt a géppel 2026.08.24 NCT-99')
  })

  it('marks chips as used once their token is in the draft', async () => {
    await mountSheet(true)
    await shoot()
    const chip = allInBody('photo-ask-chip').find(
      (el) => el.textContent?.trim() === 'M-26057',
    ) as HTMLButtonElement
    expect(chip.dataset.used).toBe('false')
    chip.click()
    await nextTick()
    expect((chip.dataset.used)).toBe('true')
  })

  it('clear button empties the draft and disables submit again', async () => {
    await mountSheet(true)
    await shoot()
    const chip = allInBody('photo-ask-chip')[0] as HTMLButtonElement
    chip.click()
    await nextTick()
    expect(((inBody('photo-ask-submit')) as HTMLButtonElement).disabled).toBe(false)
    ;(inBody('photo-ask-clear') as HTMLButtonElement).click()
    await nextTick()
    expect(((inBody('photo-ask-submit')) as HTMLButtonElement).disabled).toBe(true)
    expect(((inBody('photo-ask-draft')) as HTMLTextAreaElement).value).toBe('')
  })

  it('submit emits the built question and closes the sheet', async () => {
    const wrapper = await mountSheet(true)
    await shoot()
    const chip = allInBody('photo-ask-chip').find(
      (el) => el.textContent?.trim() === 'M-26057',
    ) as HTMLButtonElement
    chip.click()
    await nextTick()
    ;(inBody('photo-ask-submit') as HTMLButtonElement).click()
    await nextTick()
    const submitted = wrapper.emitted('submit')
    expect(submitted).toHaveLength(1)
    expect(submitted![0][0]).toBe('M-26057')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('retake returns to the capture stage', async () => {
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-draft')).not.toBeNull()
    ;(inBody('photo-ask-retake') as HTMLButtonElement).click()
    await nextTick()
    expect(inBody('photo-ask-steps')).not.toBeNull()
    expect(inBody('photo-ask-snap')).not.toBeNull()
  })
})

describe('PhotoAskSheet — empty OCR result', () => {
  const EMPTY_CASCADE = () =>
    mocks.cascade.mockResolvedValue({
      best: { text: '', confidence: 0.1, serial: null, candidates: [] },
      bestLabel: 'original',
      needsPicker: true,
      variants: [],
    })

  it('shows the explicit empty state when nothing readable was found', async () => {
    EMPTY_CASCADE()
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-empty')).not.toBeNull()
    expect(document.body.textContent).toContain('Nem találtunk olvasható szöveget')
  })

  it('empty state retake goes back to capture', async () => {
    EMPTY_CASCADE()
    await mountSheet(true)
    await shoot()
    ;(inBody('photo-ask-retake') as HTMLButtonElement).click()
    await nextTick()
    expect(inBody('photo-ask-empty')).toBeNull()
    expect(inBody('photo-ask-snap')).not.toBeNull()
  })

  it('empty state offers dictation; tapping emits dictate and closes (Pack 1 D3)', async () => {
    EMPTY_CASCADE()
    const wrapper = await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-dictate')).not.toBeNull()
    ;(inBody('photo-ask-dictate') as HTMLButtonElement).click()
    await nextTick()
    expect(wrapper.emitted('dictate')).toHaveLength(1)
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('OCR failure surfaces the error message', async () => {
    mocks.cascade.mockRejectedValue(new Error('worker crashed'))
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-empty')).not.toBeNull()
    expect(document.body.textContent).toContain('Az olvasás nem sikerült')
  })
})

// ---------------------------------------------------------------------------
// Pack 1 additions (2026-08-25): crop stage + variant picker
// ---------------------------------------------------------------------------

const LOW_VARIANTS = () => ({
  best: { text: '', confidence: 0.2, serial: null, candidates: [] },
  bestLabel: 'clean' as const,
  needsPicker: true,
  variants: [
    { label: 'gray' as const, blob: new Blob(['g']), url: 'blob:gray' },
    { label: 'threshold' as const, blob: new Blob(['t']), url: 'blob:thr' },
    { label: 'clean' as const, blob: new Blob(['c']), url: 'blob:clean' },
  ],
})

describe('PhotoAskSheet — crop stage (Pack 1 A6)', () => {
  it('shows the crop stage right after shooting; OCR has not started', async () => {
    await mountSheet(true)
    await pickFile()
    expect(inBody('photo-ask-crop')).not.toBeNull()
    expect(inBody('photo-ask-crop-confirm')).not.toBeNull()
    expect(inBody('photo-ask-crop-skip')).not.toBeNull()
    expect(mocks.cascade).not.toHaveBeenCalled()
  })

  it('confirm falls back to the original file when the image cannot decode', async () => {
    // happy-dom cannot decode the File into an <img>, so the crop
    // component must emit null and the sheet reads the ORIGINAL.
    mocks.cascade.mockResolvedValue({
      best: { text: PLATE_TEXT, confidence: 0.9, serial: null, candidates: [] },
      bestLabel: 'original',
      needsPicker: false,
      variants: [],
    })
    await mountSheet(true)
    await pickFile()
    ;(inBody('photo-ask-crop-confirm') as HTMLButtonElement).click()
    await flushPromises()
    await nextTick()
    expect(mocks.cascade).toHaveBeenCalledTimes(1)
    expect(inBody('photo-ask-draft')).not.toBeNull()
  })

  it('skip runs the cascade on the untouched capture', async () => {
    mocks.cascade.mockResolvedValue({
      best: { text: PLATE_TEXT, confidence: 0.9, serial: null, candidates: [] },
      bestLabel: 'original',
      needsPicker: false,
      variants: [],
    })
    await mountSheet(true)
    await shoot()
    expect(mocks.cascade).toHaveBeenCalledTimes(1)
    expect(inBody('photo-ask-chips')).not.toBeNull()
  })
})

describe('PhotoAskSheet — variant picker (Pack 1 B10)', () => {
  it('offers preprocessed thumbnails when every automatic pass reads poorly', async () => {
    mocks.cascade.mockResolvedValue(LOW_VARIANTS())
    await mountSheet(true)
    await shoot()
    expect(inBody('photo-ask-variants')).not.toBeNull()
    expect(allInBody('photo-ask-variant').length).toBe(3)
    // No chips yet — nothing was accepted as a read.
    expect(inBody('photo-ask-chips')).toBeNull()
  })

  it('runs a final OCR pass on the picked variant and shows its chips', async () => {
    mocks.cascade.mockResolvedValue(LOW_VARIANTS())
    mocks.recognize.mockResolvedValue({
      text: 'M17191 hiba',
      confidence: 0.88,
      serial: 'M17191',
      candidates: ['M17191'],
    })
    await mountSheet(true)
    await shoot()
    const thr = allInBody('photo-ask-variant').find(
      (el) => el.getAttribute('data-label') === 'threshold',
    ) as HTMLButtonElement
    thr.click()
    await flushPromises()
    await nextTick()
    expect(mocks.recognize).toHaveBeenCalledTimes(1)
    expect(inBody('photo-ask-variants')).toBeNull()
    expect(allInBody('photo-ask-chip').length).toBeGreaterThan(0)
    expect(inBody('photo-ask-low-confidence')).toBeNull()
  })
})
