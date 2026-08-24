// tests/voice-handsfree.spec.ts
//
// Hands-free voice dictation flow (2026-08-24 mobile-first feature).
//
// Covers:
//   1. useVoiceInput: continuous mode auto-restarts on `onend` when
//      Chrome desktop ends the session after each `isFinal`. We verify
//      that start() is called again within the rearm window.
//   2. useVoiceInput: silence timer fires submit after HANDSFREE_SILENCE_MS.
//   3. useVoiceInput: hard cap (MAX_HANDSFREE_SECONDS) stops the session
//      and emits submit even if the user never speaks.
//   4. useVoiceInput: stopHandsfree(false) discards the buffer (no submit).
//   5. useVoiceInput: tap mode unchanged — single final, auto-stop, no
//      auto-submit unless user manually stops.
//   6. VoiceDictationSheet: opens on `open=true`, mounts to body via
//      Teleport, exposes the live transcript testid.
//   7. VoiceDictationSheet: cancel button closes the sheet without
//      emitting submit.
//   8. VoiceDictationSheet: silence auto-submit closes the sheet and
//      forwards the buffered text.
//   9. AskBar: long-press fires `mic-handsfree`, short click still
//      fires `mic-toggle`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AskBar from '../src/components/AskBar.vue'
import VoiceDictationSheet from '../src/components/VoiceDictationSheet.vue'

// ---------------------------------------------------------------------------
// SpeechRecognition mock — happy-dom has no native Web Speech API.
// We build a tiny fake that records start/stop/abort calls and lets
// the test drive `onresult` / `onend` / `onerror` synchronously.
// ---------------------------------------------------------------------------

type Listener<T> = ((ev: T) => void) | null

interface FakeRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onstart: Listener<void>
  onresult: Listener<{
    resultIndex: number
    results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
  }>
  onend: Listener<void>
  onerror: Listener<{ error: string }>
}

let lastRecognition: FakeRecognition | null = null
let startSpy: ReturnType<typeof vi.fn>

function installRecognition() {
  startSpy = vi.fn()
  const w = window as unknown as {
    SpeechRecognition: new () => FakeRecognition
    webkitSpeechRecognition: new () => FakeRecognition
  }
  function Ctor() {
    const rec: FakeRecognition = {
      lang: '',
      interimResults: false,
      continuous: false,
      maxAlternatives: 0,
      start() {
        startSpy()
        if (this.onstart) this.onstart()
      },
      stop() {
        // Real Chrome fires onend shortly after stop(). We do it
        // synchronously here so the test can assert on the re-arm.
        if (this.onend) this.onend()
      },
      abort() {
        if (this.onend) this.onend()
      },
      onstart: null,
      onresult: null,
      onend: null,
      onerror: null,
    }
    lastRecognition = rec
    return rec
  }
  w.SpeechRecognition = Ctor as unknown as new () => FakeRecognition
  w.webkitSpeechRecognition = Ctor as unknown as new () => FakeRecognition
}

function uninstallRecognition() {
  const w = window as unknown as {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  delete w.SpeechRecognition
  delete w.webkitSpeechRecognition
  lastRecognition = null
}

beforeEach(() => {
  setActivePinia(createPinia())
  installRecognition()
  // Re-import the composable AFTER the global stub is in place, so the
  // module-level `recognitionCtor()` call sees the fake.
  vi.resetModules()
})

afterEach(() => {
  uninstallRecognition()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// useVoiceInput
// ---------------------------------------------------------------------------

describe('useVoiceInput — hands-free mode', () => {
  it('starts the recognition when startHandsfree is called', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    voice.startHandsfree()
    expect(voice.listening.value).toBe(true)
    expect(voice.mode.value).toBe('handsfree')
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it('re-arms the recognition on onend in hands-free mode (Chrome behavior)', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    voice.startHandsfree()
    expect(startSpy).toHaveBeenCalledTimes(1)
    // Simulate Chrome desktop ending after one final.
    expect(lastRecognition).not.toBeNull()
    lastRecognition!.onend?.()
    // The re-arm is scheduled via setTimeout(80ms).
    await new Promise((r) => setTimeout(r, 120))
    expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does NOT re-arm when the user manually stops in hands-free mode', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    voice.startHandsfree()
    expect(startSpy).toHaveBeenCalledTimes(1)
    // Simulate the silence path calling stop() internally.
    voice.stopHandsfree(true)
    // After stop(), our fake fires onend synchronously, which the
    // composable sees with `manualStop = true` and cleans up.
    lastRecognition!.onend?.()
    await new Promise((r) => setTimeout(r, 120))
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it('emits submit on silence timer expiry with the buffered final text', async () => {
    vi.useFakeTimers()
    const { useVoiceInput, HANDSFREE_SILENCE_MS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    // Simulate a finalized phrase.
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'M17191 előzménye' }], { isFinal: true, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Advance past the silence window.
    vi.advanceTimersByTime(HANDSFREE_SILENCE_MS + 50)
    expect(onSubmit).toHaveBeenCalledWith('M17191 előzménye')
    expect(voice.listening.value).toBe(false)
  })

  it('cancels without submit when the user dismisses', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'valami' }], { isFinal: true, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    voice.stopHandsfree(false)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(voice.listening.value).toBe(false)
  })

  it('respects the hard cap (MAX_HANDSFREE_SECONDS)', async () => {
    vi.useFakeTimers()
    const { useVoiceInput, MAX_HANDSFREE_SECONDS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    // Even with no finals, after the cap expires the buffer (empty)
    // is flushed and the session is torn down.
    vi.advanceTimersByTime(MAX_HANDSFREE_SECONDS * 1000 + 50)
    // Empty buffer means no submit, but the session is gone.
    expect(voice.listening.value).toBe(false)
  })

  it('resets the silence timer on interim results too (not just finals)', async () => {
    // Regression test for the 2026-08-24 "it quits before I complete
    // the sentence" bug. The silence timer used to only re-arm on
    // `isFinal: true` events, so a long multi-sentence question would
    // submit prematurely after the first sentence's final + 1.2s of
    // interim-only activity on the second sentence.
    vi.useFakeTimers()
    const { useVoiceInput, HANDSFREE_SILENCE_MS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    // First sentence: isFinal=true.
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'első mondat' }], { isFinal: true, length: 1 })] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Advance HALF the silence window.
    vi.advanceTimersByTime(HANDSFREE_SILENCE_MS / 2)
    // Second sentence streams interims — silence timer should re-arm.
    // Web Speech API shape: the new event carries the new result at
    // `results[resultIndex]`; older results come before it.
    lastRecognition!.onresult?.({
      resultIndex: 1,
      results: [
        Object.assign([{ transcript: 'első mondat' }], { isFinal: true, length: 1 }),
        Object.assign([{ transcript: 'második mondat' }], { isFinal: false, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Advance ANOTHER half. Total elapsed from first final would be
    // 1x window — the OLD bug would have submitted by now. The new
    // behaviour re-armed on the interim, so onSubmit is still 0.
    vi.advanceTimersByTime(HANDSFREE_SILENCE_MS / 2 + 50)
    expect(onSubmit).not.toHaveBeenCalled()
    // Now go fully silent — submit should fire after one more window.
    vi.advanceTimersByTime(HANDSFREE_SILENCE_MS + 50)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('extendSilence pushes the countdown forward without ending the session', async () => {
    vi.useFakeTimers()
    const { useVoiceInput, HANDSFREE_SILENCE_MS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    // Almost at the silence boundary.
    vi.advanceTimersByTime(HANDSFREE_SILENCE_MS - 100)
    // User taps "Több idő".
    voice.extendSilence()
    // The original timer would have fired at HANDSFREE_SILENCE_MS —
    // but extendSilence re-armed it, so 200ms later (past the
    // original boundary) onSubmit should still be 0.
    vi.advanceTimersByTime(200)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('promotes the in-flight interim into finalText on submit (so tail interims are not lost)', async () => {
    const { useVoiceInput, HANDSFREE_SILENCE_MS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    // First sentence finalizes.
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'befejezett mondat' }], { isFinal: true, length: 1 })] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Second sentence is mid-utterance — only interim so far.
    // In the real Web Speech API, the new event carries the new
    // result at `results[resultIndex]` and the older results below
    // it. We rebuild the `results` array to mirror that shape.
    lastRecognition!.onresult?.({
      resultIndex: 1,
      results: [
        Object.assign([{ transcript: 'befejezett mondat' }], { isFinal: true, length: 1 }),
        Object.assign([{ transcript: 'félkész folytatás' }], { isFinal: false, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // User taps "Stop & küldés" before the second sentence finalizes.
    voice.stopHandsfree(true)
    // submitHandsfree should promote the interim into finalText.
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toBe('befejezett mondat félkész folytatás')
  })
})

describe('useVoiceInput — tap mode (backward compat)', () => {
  it('appends the very first final to the onFinal listeners', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onFinal = vi.fn()
    voice.onFinal(onFinal)
    voice.startTap()
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'szerviz' }], { isFinal: true, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    expect(onFinal).toHaveBeenCalledWith('szerviz')
  })

  it('emits no submit on silence in tap mode (no auto-submit, only appends)', async () => {
    vi.useFakeTimers()
    const { useVoiceInput, HANDSFREE_SILENCE_MS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startTap()
    vi.advanceTimersByTime(HANDSFREE_SILENCE_MS * 5)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// VoiceDictationSheet
// ---------------------------------------------------------------------------

describe('VoiceDictationSheet', () => {
  it('mounts to <body> via Teleport and shows the live-transcript testid', async () => {
    document.body.innerHTML = ''
    const wrapper = mount(VoiceDictationSheet, {
      props: { open: false },
      attachTo: document.body,
    })
    await wrapper.setProps({ open: true })
    await nextTick()
    await nextTick()
    const transcript = document.body.querySelector('[data-testid="voice-sheet-transcript"]')
    expect(transcript).not.toBeNull()
    wrapper.unmount()
  })

  it('does not render the sheet when open is false', () => {
    document.body.innerHTML = ''
    const wrapper = mount(VoiceDictationSheet, {
      props: { open: false },
      attachTo: document.body,
    })
    expect(document.body.querySelector('[data-testid="voice-sheet"]')).toBeNull()
    wrapper.unmount()
  })

  it('cancel button emits update:open false and does not submit', async () => {
    document.body.innerHTML = ''
    const wrapper = mount(VoiceDictationSheet, {
      props: { open: true },
      attachTo: document.body,
    })
    await nextTick()
    const cancel = document.body.querySelector('[data-testid="voice-sheet-cancel"]') as HTMLButtonElement | null
    expect(cancel).not.toBeNull()
    cancel!.click()
    await nextTick()
    const opens = wrapper.emitted('update:open')
    expect(opens?.[0]).toEqual([false])
    const subs = wrapper.emitted('submit')
    expect(subs).toBeUndefined()
    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// AskBar long-press
// ---------------------------------------------------------------------------

describe('AskBar — long-press for hands-free', () => {
  it('short click emits mic-toggle', async () => {
    const wrapper = mount(AskBar, {
      props: { modelValue: '', mic: true, micHandsFreeHint: true },
    })
    const mic = wrapper.get('[data-testid="ask-bar-mic"]')
    // Short press: mousedown + mouseup well before the 450ms threshold.
    await mic.trigger('mousedown')
    await new Promise((r) => setTimeout(r, 50))
    await mic.trigger('mouseup')
    await mic.trigger('click')
    expect(wrapper.emitted('mic-toggle')).toBeDefined()
    expect(wrapper.emitted('mic-handsfree')).toBeUndefined()
  })

  it('long press emits mic-handsfree and swallows the subsequent click', async () => {
    const wrapper = mount(AskBar, {
      props: { modelValue: '', mic: true, micHandsFreeHint: true },
    })
    const mic = wrapper.get('[data-testid="ask-bar-mic"]')
    await mic.trigger('mousedown')
    // Wait past the 450ms threshold.
    await new Promise((r) => setTimeout(r, 500))
    // The composable fires the event inside the timer; the click after
    // release should NOT also fire mic-toggle because longPressFired is true.
    await mic.trigger('mouseup')
    await mic.trigger('click')
    expect(wrapper.emitted('mic-handsfree')).toBeDefined()
    expect(wrapper.emitted('mic-toggle')).toBeUndefined()
  })

  it('does not arm the long-press timer when micHandsFreeHint is false', async () => {
    const wrapper = mount(AskBar, {
      props: { modelValue: '', mic: true, micHandsFreeHint: false },
    })
    const mic = wrapper.get('[data-testid="ask-bar-mic"]')
    await mic.trigger('mousedown')
    await new Promise((r) => setTimeout(r, 500))
    await mic.trigger('mouseup')
    await mic.trigger('click')
    expect(wrapper.emitted('mic-handsfree')).toBeUndefined()
    expect(wrapper.emitted('mic-toggle')).toBeDefined()
  })
})
