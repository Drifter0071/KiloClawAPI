// tests/voice-handsfree.spec.ts
//
// Hands-free voice dictation flow (2026-08-24 mobile-first feature).
//
// Covers:
//   1. useVoiceInput: continuous mode auto-restarts on `onend` when
//      Chrome desktop ends the session after each `isFinal`. We verify
//      that start() is called again within the rearm window.
//   2. useVoiceInput: NO silence auto-submit (GBoard-style, 2026-08-24).
//      The user finishes by tapping the "Stop & küldés" button — there
//      is no internal deadline. extendSilence / HANDSFREE_SILENCE_MS
//      have been removed.
//   3. useVoiceInput: hard cap (MAX_HANDSFREE_SECONDS) stops the session
//      and emits submit even if the user never speaks.
//   4. useVoiceInput: stopHandsfree(false) discards the buffer (no submit).
//      stopHandsfree(true) submits the buffer.
//   5. useVoiceInput: tap mode is CONTINUOUS too (2026-08-25) — the mic
//      is a toggle; finals stream as incremental fragments, the mic
//      never stops on speech, tapping it off flushes the in-flight
//      interim, and a pending re-arm cannot resurrect a stopped mic.
//   6. VoiceDictationSheet: opens on `open=true`, mounts to body via
//      Teleport, exposes the live transcript testid.
//   7. VoiceDictationSheet: cancel button closes the sheet without
//      emitting submit.
//   8. AskBar: long-press fires `mic-handsfree`, short click still
//      fires `mic-toggle`.
//   9. useVoiceInput: duplicate-final replay guards (2026-08-25) —
//      Chrome's double-delivery of the same finalized result (same-
//      index re-fire before onend; re-armed session replaying the
//      previous last final) is dropped, so words never land twice.

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
    // The user explicitly taps "Stop & küldés" (or "Mégse").
    voice.stopHandsfree(true)
    // After stop(), our fake fires onend synchronously, which the
    // composable sees with `manualStop = true` and cleans up.
    lastRecognition!.onend?.()
    await new Promise((r) => setTimeout(r, 120))
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT auto-submit on silence (GBoard behaviour, 2026-08-24)', async () => {
    // Regression test: the previous design fired submit after a silence
    // window (1.2s / 2.5s / 5s). That always cut off multi-sentence
    // questions mid-utterance. The current design has no silence
    // deadline — the user taps "Stop & küldés" to finish. Verify the
    // no-submit guarantee explicitly.
    vi.useFakeTimers()
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
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
    // Advance a full minute. With the OLD design this would have
    // submitted long ago. With the NEW design nothing happens.
    vi.advanceTimersByTime(60_000)
    expect(onSubmit).not.toHaveBeenCalled()
    // The session is still live — the mic is still on.
    expect(voice.listening.value).toBe(true)
  })

  it('cancels without submit when the user dismisses (Mégse)', async () => {
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

  it('does NOT auto-submit across many interim + final results (long multi-sentence question)', async () => {
    // Regression for the 2026-08-24 "stops after 1 word" bug. The OLD
    // silence-timer design submitted after the first sentence's final
    // + the silence window, no matter how much subsequent interim /
    // final activity was happening. The NEW design lets the user keep
    // talking as long as they want.
    vi.useFakeTimers()
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startHandsfree()
    // First sentence finalizes.
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'első mondat' }], { isFinal: true, length: 1 })] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Second sentence streams interims for a long time.
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(200)
      lastRecognition!.onresult?.({
        resultIndex: 1,
        results: [
          Object.assign([{ transcript: 'első mondat' }], { isFinal: true, length: 1 }),
          Object.assign([{ transcript: `második folytatás ${i}` }], { isFinal: false, length: 1 }),
        ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
      })
    }
    // 4 seconds in — the OLD design would have submitted 3+ times over.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(voice.listening.value).toBe(true)
  })

  it('promotes the in-flight interim into finalText on submit (so tail interims are not lost)', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
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

  it('exposes no extendSilence (GBoard has no silence deadline to extend)', async () => {
    const mod = await import('../src/composables/useVoiceInput')
    const voice = mod.useVoiceInput()
    // The composable surface intentionally does not include
    // extendSilence any more — there's no silence deadline to extend.
    expect((voice as unknown as { extendSilence?: unknown }).extendSilence).toBeUndefined()
    // HANDSFREE_SILENCE_MS is also gone (no constant for it).
    expect((mod as unknown as { HANDSFREE_SILENCE_MS?: unknown }).HANDSFREE_SILENCE_MS).toBeUndefined()
  })
})

describe('useVoiceInput — tap mode (continuous, GBoard-style 2026-08-25)', () => {
  it('hands each final to onFinal as an incremental fragment and KEEPS listening', async () => {
    // Regression for the 2026-08-25 "cuts off after 1 word" bug: the
    // old tap design stopped after the very first final, so Chrome's
    // early micro-pause finals ("kritik" instead of "kritikus hiba")
    // truncated the utterance. Tap is a toggle now.
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onFinal = vi.fn()
    voice.onFinal(onFinal)
    voice.startTap()
    expect(startSpy).toHaveBeenCalledTimes(1)
    // First early final (Chrome split mid-word).
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'kritik' }], { isFinal: true, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    expect(onFinal).toHaveBeenLastCalledWith('kritik')
    // The mic must STILL be on — this is the core regression assert.
    expect(voice.listening.value).toBe(true)
    expect(startSpy).toHaveBeenCalledTimes(1) // never stopped
    // Second final arrives (same session).
    lastRecognition!.onresult?.({
      resultIndex: 1,
      results: [
        Object.assign([{ transcript: 'kritik' }], { isFinal: true, length: 1 }),
        Object.assign([{ transcript: 'hiba' }], { isFinal: true, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Fragments are incremental (NOT the whole buffer — AskPage joins
    // them onto the input itself).
    expect(onFinal).toHaveBeenLastCalledWith('hiba')
    expect(onFinal).toHaveBeenCalledTimes(2)
    expect(voice.finalText.value).toBe('kritik hiba')
    expect(voice.listening.value).toBe(true)
  })

  it('flushes the in-flight interim when the mic is tapped off', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onFinal = vi.fn()
    voice.onFinal(onFinal)
    voice.startTap()
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'kritikus' }], { isFinal: true, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // Tail of the phrase still streaming as interim…
    lastRecognition!.onresult?.({
      resultIndex: 1,
      results: [
        Object.assign([{ transcript: 'kritikus' }], { isFinal: true, length: 1 }),
        Object.assign([{ transcript: 'hiba' }], { isFinal: false, length: 1 }),
      ] as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>,
    })
    // …and the user taps the mic off before "hiba" finalizes.
    voice.stopTap()
    expect(onFinal).toHaveBeenLastCalledWith('hiba')
    expect(voice.listening.value).toBe(false)
  })

  it('re-arms after Chrome naturally ends the session in tap mode', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    voice.startTap()
    expect(startSpy).toHaveBeenCalledTimes(1)
    // Chrome desktop ends after each final even with continuous=true.
    lastRecognition!.onend?.()
    await new Promise((r) => setTimeout(r, 120))
    expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(voice.mode.value).toBe('tap')
  })

  it('does NOT resurrect the mic after the user taps it off (pending re-arm killed)', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    voice.startTap()
    // Natural end schedules an 80ms re-arm…
    lastRecognition!.onend?.()
    // …but the user taps the mic off before it fires.
    voice.stopTap()
    const callsAfterStop = startSpy.mock.calls.length
    await new Promise((r) => setTimeout(r, 140))
    expect(startSpy.mock.calls.length).toBe(callsAfterStop)
    expect(voice.listening.value).toBe(false)
  })

  it('emits no submit in tap mode (tap mode never auto-submits)', async () => {
    vi.useFakeTimers()
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onSubmit = vi.fn()
    voice.onSubmit(onSubmit)
    voice.startTap()
    vi.advanceTimersByTime(5_000)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Duplicate-final replay guards (2026-08-25 "words appear twice" bug).
// Chrome delivers the SAME finalized result twice in two shapes:
//   #1 two back-to-back onresult events repeating the resultIndex right
//      before onend (same recognition instance);
//   #2 the re-armed session instantly replaying the previous session's
//      last final at its own index 0.
// ---------------------------------------------------------------------------

describe('useVoiceInput — duplicate-final replay guards', () => {
  function finalResult(transcript: string) {
    return Object.assign([{ transcript }], { isFinal: true, length: 1 }) as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
  }

  it('drops a back-to-back re-delivery of the SAME finalized index (shape #1)', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onFinal = vi.fn()
    voice.onFinal(onFinal)
    voice.startTap()
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [finalResult('kritikus hiba')],
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
    // Chrome quirk: milliseconds later the same final arrives again at
    // the same resultIndex, just before onend.
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [finalResult('kritikus hiba')],
    })
    // The composer must NOT receive it a second time.
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(voice.finalText.value).toBe('kritikus hiba')
  })

  it('drops the re-armed session replaying the previous final (shape #2)', async () => {
    const { useVoiceInput } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onFinal = vi.fn()
    voice.onFinal(onFinal)
    voice.startTap()
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [finalResult('hiba')],
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
    // Chrome ends the session; the composable re-arms ~80ms later.
    lastRecognition!.onend?.()
    await new Promise((r) => setTimeout(r, 120))
    expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    // First event of the NEW session replays the OLD final verbatim.
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [finalResult('hiba')],
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
    // Genuinely new content must still land. Real events carry the
    // full accumulated results array; resultIndex marks the new tail.
    // The replayed index-0 final is skipped by the window guard even
    // though this instance has never seen it.
    lastRecognition!.onresult?.({
      resultIndex: 1,
      results: [finalResult('hiba'), finalResult('vezérlő')],
    })
    expect(onFinal).toHaveBeenCalledTimes(2)
    expect(onFinal).toHaveBeenLastCalledWith('vezérlő')
    expect(voice.finalText.value).toBe('hiba vezérlő')
  })

  it('still delivers an identical final once the dedup window has expired', async () => {
    // A fresh session repeating the same word AFTER the window is real
    // speech, not a Chrome replay — it must reach the composer.
    vi.useFakeTimers()
    const { useVoiceInput, REPLAY_DEDUP_WINDOW_MS } = await import('../src/composables/useVoiceInput')
    const voice = useVoiceInput()
    const onFinal = vi.fn()
    voice.onFinal(onFinal)
    voice.startTap()
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [finalResult('hiba')],
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(REPLAY_DEDUP_WINDOW_MS + 500)
    lastRecognition!.onend?.()
    vi.advanceTimersByTime(120) // fires the scheduled 80ms re-arm
    lastRecognition!.onresult?.({
      resultIndex: 0,
      results: [finalResult('hiba')],
    })
    expect(onFinal).toHaveBeenCalledTimes(2)
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

  it('no longer renders the "Több idő" affordance', async () => {
    document.body.innerHTML = ''
    const wrapper = mount(VoiceDictationSheet, {
      props: { open: true },
      attachTo: document.body,
    })
    await nextTick()
    const moreTime = document.body.querySelector('[data-testid="voice-sheet-more-time"]')
    expect(moreTime).toBeNull()
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
