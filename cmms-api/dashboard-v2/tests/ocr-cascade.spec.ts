// tests/ocr-cascade.spec.ts
//
// Pack 1 (2026-08-25) cascade orchestration for the Fotó OCR flow.
// Tesseract.js and the canvas preprocessing are both mocked — we are
// testing runOcrCascade's DECISIONS, not the WASM engine:
//
//   1. early-stop when a pass reads confidently (no wasted passes)
//   2. escalation to 'threshold' when the original reads poorly
//   3. needsPicker + variant passthrough when everything reads badly
//   4. one shared worker across cascades (createWorker called once —
//      the old code paid worker startup EVERY photo)
//   5. serial extraction still works off the winning pass

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  loadImageToCanvas: vi.fn(),
  buildVariants: vi.fn(),
}))

vi.mock('tesseract.js', () => ({
  OEM: { LSTM_ONLY: '1' },
  PSM: { SPARSE_TEXT: '11' },
  createWorker: mocks.createWorker,
}))

vi.mock('@/lib/ocrPreprocess', () => ({
  loadImageToCanvas: mocks.loadImageToCanvas,
  buildVariants: mocks.buildVariants,
}))

import {
  releaseVariants,
  runOcrCascade,
} from '../src/lib/ocrSerial'

function fakeVariants() {
  return [
    { label: 'gray' as const, blob: new Blob(['g']), url: 'blob:gray' },
    { label: 'threshold' as const, blob: new Blob(['t']), url: 'blob:thr' },
    { label: 'clean' as const, blob: new Blob(['c']), url: 'blob:clean' },
  ]
}

/** Queue recognition results in pass order
 *  (original -> threshold -> clean). */
function queueReads(reads: Array<{ text: string; confidence: number }>) {
  let call = 0
  mocks.recognize.mockImplementation(async () => {
    const r = reads[Math.min(call, reads.length - 1)]!
    call += 1
    return { data: { text: r.text, confidence: r.confidence * 100 } }
  })
}

beforeEach(() => {
  // NOTE: mockImplementation, NOT mockReset — the worker singleton
  // inside ocrSerial survives across tests, so createWorker's call
  // HISTORY must survive too for the reuse assertion below.
  mocks.createWorker.mockImplementation(async () => ({
    setParameters: async () => {},
    recognize: mocks.recognize,
  }))
  mocks.recognize.mockReset()
  mocks.loadImageToCanvas.mockResolvedValue({ width: 100, height: 100 })
  mocks.buildVariants.mockResolvedValue(fakeVariants())
})

describe('runOcrCascade', () => {
  it('stops after the first confident pass (original reads fine)', async () => {
    queueReads([{ text: 'M17191 hiba', confidence: 0.92 }])
    const out = await runOcrCascade(new File(['x'], 'p.jpg'))
    expect(mocks.recognize).toHaveBeenCalledTimes(1)
    expect(out.bestLabel).toBe('original')
    expect(out.needsPicker).toBe(false)
    expect(out.best.serial).toBe('M17191')
  })

  it('escalates to the threshold pass when the original reads poorly', async () => {
    queueReads([
      { text: '', confidence: 0.15 },
      { text: 'NCT99 vezerlo hiba', confidence: 0.81 },
    ])
    const out = await runOcrCascade(new File(['x'], 'p.jpg'))
    expect(mocks.recognize).toHaveBeenCalledTimes(2)
    expect(out.bestLabel).toBe('threshold')
    expect(out.best.text).toContain('NCT99')
    expect(out.needsPicker).toBe(false)
  })

  it('reports needsPicker and hands over variants when all passes fail', async () => {
    queueReads([
      { text: '', confidence: 0.2 },
      { text: '~?#~', confidence: 0.3 },
      { text: '', confidence: 0.25 },
    ])
    const out = await runOcrCascade(new File(['x'], 'p.jpg'))
    expect(mocks.recognize).toHaveBeenCalledTimes(3)
    expect(out.needsPicker).toBe(true)
    expect(out.variants.length).toBe(3)
    expect(out.variants.map((v) => v.label)).toEqual([
      'gray',
      'threshold',
      'clean',
    ])
  })

  it('degrades gracefully when canvas preprocessing is unavailable', async () => {
    mocks.buildVariants.mockRejectedValue(new Error('canvas-unavailable'))
    queueReads([{ text: 'M17191', confidence: 0.7 }])
    const out = await runOcrCascade(new File(['x'], 'p.jpg'))
    expect(mocks.recognize).toHaveBeenCalledTimes(1)
    expect(out.variants).toEqual([])
    expect(out.needsPicker).toBe(false)
    expect(out.best.serial).toBe('M17191')
  })

  it('reuses ONE worker across cascades instead of respawning per call', async () => {
    const before = mocks.createWorker.mock.calls.length
    queueReads([{ text: 'a', confidence: 0.9 }])
    await runOcrCascade(new File(['x'], '1.jpg'))
    const afterFirst = mocks.createWorker.mock.calls.length
    // The first cascade may or may not have created the singleton
    // (earlier tests in this file may have), but the SECOND cascade
    // must never spawn another worker.
    expect(afterFirst).toBeLessThanOrEqual(before + 1)
    queueReads([{ text: 'b', confidence: 0.9 }])
    await runOcrCascade(new File(['x'], '2.jpg'))
    expect(mocks.createWorker.mock.calls.length).toBe(afterFirst)
  })

  it('releaseVariants revokes every thumbnail URL (UI lifecycle helper)', () => {
    const vs = fakeVariants()
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    releaseVariants(vs)
    expect(spy).toHaveBeenCalledTimes(3)
    spy.mockRestore()
  })

  it('prefers a higher-scoring later pass even after an early mediocre read', async () => {
    queueReads([
      { text: 'M17191', confidence: 0.55 }, // below GOOD_ENOUGH → continue
      { text: 'M17191 vezerlo hiba reszletek', confidence: 0.58 }, // better score
      { text: '', confidence: 0.4 },
    ])
    const out = await runOcrCascade(new File(['x'], 'p.jpg'))
    expect(out.bestLabel).toBe('threshold')
    expect(out.best.text).toContain('vezerlo')
    // Third pass still runs (0.58 < GOOD_ENOUGH) but must NOT win.
    expect(mocks.recognize).toHaveBeenCalledTimes(3)
    expect(out.needsPicker).toBe(false)
  })
})
