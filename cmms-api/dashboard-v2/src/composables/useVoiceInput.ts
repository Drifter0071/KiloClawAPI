// src/composables/useVoiceInput.ts
//
// Hungarian dictation for the Ask bar. Two modes:
//
//   - "tap"        (default) — single-shot: tap the mic, dictate one
//                   phrase, it appends to the input, mic auto-stops.
//                   The original 2026-08-19 behaviour, kept for the
//                   AskBar 40×40 icon.
//
//   - "handsfree"  (new)     — continuous: the mic stays on across
//                   multiple sentences. The user dictates a long
//                   question, then either:
//                     (a) pauses for `HANDSFREE_SILENCE_MS` (default
//                         1200ms) and the sheet auto-submits, or
//                     (b) taps the big "Stop & küldés" button.
//                   Interim transcript streams in real time to the
//                   `interimText` ref; finals are appended to a single
//                   `finalText` buffer; the sheet reads `finalText +
//                   interimText` for the live preview.
//
// Why continuous mode is tricky: Chrome desktop stops `onend` after
// each `isFinal` result (even with `continuous = true`) and on iOS
// Safari the session can time out after ~60s of silence. We solve
// this by re-arming the recognition inside `onend` whenever the user
// is still in hands-free mode and `manualStop` is false. There's a
// hard ceiling of `MAX_HANDSFREE_SECONDS` (default 120s) so the
// session can never run away.
//
// Graceful degradation: when the browser has no SpeechRecognition
// at all (Firefox, older Safari), `supported` stays false and the
// mic button is hidden in both modes.

import { getCurrentInstance, onBeforeUnmount, ref } from 'vue'

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error: string }) => void) | null
  onstart: (() => void) | null
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}

export type VoiceMode = 'tap' | 'handsfree'

/** Auto-submit when no transcript activity (interim OR final) for this long. */
export const HANDSFREE_SILENCE_MS = 2500

/** Hard cap on a single hands-free session. */
export const MAX_HANDSFREE_SECONDS = 120

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const supported = ref<boolean>(recognitionCtor() !== null)
const listening = ref(false)
const error = ref<string | null>(null)
const mode = ref<VoiceMode>('tap')
const interimText = ref<string>('')
const finalText = ref<string>('')
const sessionStartedAt = ref<number | null>(null)

let recognition: SpeechRecognitionLike | null = null
let manualStop = false
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let hardCapTimer: ReturnType<typeof setTimeout> | null = null
const finalListeners: Array<(text: string) => void> = []
const submitListeners: Array<(text: string) => void> = []
const modeListeners: Array<(m: VoiceMode) => void> = []

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer)
    silenceTimer = null
  }
}

function clearHardCapTimer() {
  if (hardCapTimer) {
    clearTimeout(hardCapTimer)
    hardCapTimer = null
  }
}

function armSilenceTimer() {
  if (mode.value !== 'handsfree') return
  clearSilenceTimer()
  silenceTimer = setTimeout(() => {
    // IMPORTANT: read the buffer BEFORE stopping. Stopping fires
    // `onend`, which (with manualStop=true) calls cleanup() and
    // wipes `finalText`. submitHandsfree re-checks the mode and
    // early-returns if the session is already cleaned up.
    submitHandsfree('silence')
  }, HANDSFREE_SILENCE_MS)
}

function emitSubmit(text: string) {
  for (const cb of submitListeners) cb(text)
}

function setMode(m: VoiceMode) {
  if (mode.value === m) return
  mode.value = m
  for (const cb of modeListeners) cb(m)
}

function resetBuffers() {
  finalText.value = ''
  interimText.value = ''
  sessionStartedAt.value = null
}

/**
 * Promote the current `interimText` into `finalText` (so a final
 * arrives after the session ends without a real `isFinal`). We do
 * this right before cleanup so any pending interim isn't lost when
 * the user taps "Stop & küldés" mid-utterance, or when the silence
 * timer fires while Chrome is still streaming interims.
 */
function promoteInterim() {
  const interim = interimText.value.trim()
  if (interim.length === 0) return
  finalText.value = finalText.value
    ? `${finalText.value} ${interim}`.replace(/\s+/g, ' ').trim()
    : interim
  interimText.value = ''
}

function ensureRecognition(): SpeechRecognitionLike | null {
  if (recognition) return recognition
  const Ctor = recognitionCtor()
  if (!Ctor) {
    supported.value = false
    return null
  }
  const rec = new Ctor()
  rec.lang = 'hu-HU'
  rec.interimResults = true
  rec.continuous = true
  rec.maxAlternatives = 1

  rec.onstart = () => {
    listening.value = true
    if (mode.value === 'handsfree') {
      sessionStartedAt.value = Date.now()
    }
  }

  rec.onresult = (ev: SpeechRecognitionEventLike) => {
    error.value = null
    let interim = ''
    let hasNewFinal = false
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const res = ev.results[i]!
      const transcript = res[0]?.transcript ?? ''
      if (res.isFinal) {
        const trimmed = transcript.trim()
        if (trimmed.length > 0) {
          finalText.value = finalText.value
            ? `${finalText.value} ${trimmed}`.replace(/\s+/g, ' ').trim()
            : trimmed
        }
        hasNewFinal = true
      } else {
        interim += transcript
      }
    }
    interimText.value = interim
    if (mode.value === 'handsfree') {
      // Reset the silence countdown on ANY transcript activity —
      // both finals and interims. Earlier this only reset on finals,
      // which made a long multi-sentence question submit prematurely
      // after the first sentence's final + 1.2s of interim-only
      // activity (the timer kept ticking because hasNewFinal was
      // false for the second sentence's interims). Resetting on
      // interims too means the timer only fires when the user has
      // truly gone silent (no `onresult` event at all).
      if (hasNewFinal || interim.length > 0) {
        armSilenceTimer()
      }
    } else {
      // tap mode — append the very first final we get.
      if (hasNewFinal) {
        const flushed = finalText.value
        // Notify tap-mode consumers (AskPage appends to the input).
        for (const cb of finalListeners) cb(flushed)
        // Stop after one final.
        manualStop = true
        try {
          rec.stop()
        } catch {
          // ignore
        }
      }
    }
  }

  rec.onend = () => {
    listening.value = false
    recognition = null
    if (mode.value === 'handsfree' && !manualStop) {
      // Some browsers (Chrome desktop) end after each `isFinal` even
      // with `continuous = true`. Re-arm if we're still in handsfree
      // and the hard cap hasn't fired yet.
      const start = sessionStartedAt.value
      if (start && Date.now() - start < MAX_HANDSFREE_SECONDS * 1000) {
        // Tiny backoff to avoid a hot loop if onend fires repeatedly.
        setTimeout(() => {
          if (mode.value === 'handsfree' && !manualStop && !recognition) {
            startRecognition('rearm')
          }
        }, 80)
      } else {
        // Hard cap reached.
        cleanup('timeout')
      }
    } else if (mode.value === 'handsfree' && manualStop) {
      // User tapped "Stop & küldés" or silence fired.
      cleanup('manual')
    }
  }

  rec.onerror = (ev: { error: string }) => {
    listening.value = false
    switch (ev.error) {
      case 'no-speech':
        error.value = 'Nem hallottam semmit. Próbáld újra a mikrofonnal.'
        // In handsfree, let the silence timer handle the timeout.
        if (mode.value === 'tap') {
          recognition = null
        }
        break
      case 'not-allowed':
      case 'service-not-allowed':
        error.value = 'A mikrofon használata le van tiltva a böngészőben.'
        cleanup('denied')
        break
      case 'audio-capture':
        error.value = 'Nincs mikrofon a készüléken.'
        cleanup('error')
        break
      case 'network':
        error.value = 'A beszédfelismerés hálózati hibát észlelt. Próbáld újra.'
        cleanup('error')
        break
      case 'aborted':
        // Common in Chrome when we explicitly stop() — don't toast.
        recognition = null
        listening.value = false
        break
      default:
        error.value = 'A beszédfelismerés nem működött. Próbáld újra.'
        cleanup('error')
        break
    }
  }

  recognition = rec
  return rec
}

function submitHandsfree(reason: 'silence' | 'manual' | 'timeout') {
  if (mode.value !== 'handsfree') return
  // Promote any in-flight interim into finalText so it isn't lost
  // when the user taps "Stop & küldés" or the silence timer fires
  // mid-utterance (the recogniser may have given an interim for the
  // tail of the last phrase but not yet flushed a final).
  promoteInterim()
  const text = finalText.value.trim()
  // Stop the recognition if still running.
  if (recognition) {
    try {
      recognition.abort()
    } catch {
      // ignore
    }
  }
  cleanup(reason)
  // Fire submit only if we actually captured something. Otherwise the
  // sheet just dismisses silently.
  if (text.length > 0) {
    emitSubmit(text)
  }
}

function cleanup(_reason: string) {
  clearSilenceTimer()
  clearHardCapTimer()
  if (recognition) {
    try {
      recognition.abort()
    } catch {
      // ignore
    }
    recognition = null
  }
  listening.value = false
  resetBuffers()
  manualStop = false
  setMode('tap')
}

function startRecognition(_why: 'user' | 'rearm') {
  const rec = ensureRecognition()
  if (!rec) return
  manualStop = false
  error.value = null
  if (mode.value === 'handsfree' && !sessionStartedAt.value) {
    sessionStartedAt.value = Date.now()
  }
  try {
    rec.start()
  } catch {
    // Already started / unsupported — treat as not listening.
    listening.value = false
  }
}

function startHandsfree(): void {
  if (listening.value) return
  resetBuffers()
  setMode('handsfree')
  startRecognition('user')
  // Hard cap: stop after MAX_HANDSFREE_SECONDS no matter what.
  clearHardCapTimer()
  hardCapTimer = setTimeout(() => {
    submitHandsfree('timeout')
  }, MAX_HANDSFREE_SECONDS * 1000)
  // Arm the silence timer so a user who opens the sheet and never
  // speaks doesn't hang the UI until the 120s hard cap. The timer
  // is reset on every transcript event (interim or final).
  armSilenceTimer()
}

function stopHandsfree(submit: boolean): void {
  if (mode.value !== 'handsfree') return
  if (submit) {
    submitHandsfree('manual')
  } else {
    cleanup('cancel')
  }
}

function startTap(): void {
  if (listening.value) return
  resetBuffers()
  setMode('tap')
  startRecognition('user')
}

function stopTap(): void {
  if (mode.value !== 'tap') return
  if (recognition) {
    manualStop = true
    try {
      recognition.stop()
    } catch {
      recognition = null
      listening.value = false
    }
  }
  resetBuffers()
  setMode('tap')
}

function toggle(): void {
  if (listening.value) {
    if (mode.value === 'handsfree') stopHandsfree(true)
    else stopTap()
  } else {
    startTap()
  }
}

function onFinal(cb: (text: string) => void): () => void {
  finalListeners.push(cb)
  return () => {
    const i = finalListeners.indexOf(cb)
    if (i >= 0) finalListeners.splice(i, 1)
  }
}

function onSubmit(cb: (text: string) => void): () => void {
  submitListeners.push(cb)
  return () => {
    const i = submitListeners.indexOf(cb)
    if (i >= 0) submitListeners.splice(i, 1)
  }
}

/**
 * Reset the silence countdown without ending the session. The user
 * can ask for "more time" via a UI affordance when they want to
 * compose a longer multi-sentence question.
 */
function extendSilence(): void {
  if (mode.value !== 'handsfree') return
  armSilenceTimer()
}

// Only register the unmount hook when called from inside a component
// setup() — the original 2026-08-19 module-level call produced a
// harmless but noisy Vue warning when the composable was used from
// scripts, composables, or tests. Detection: `getCurrentInstance()`
// returns the active setup instance or null.
if (getCurrentInstance()) {
  onBeforeUnmount(() => {
    cleanup('unmount')
  })
}

export function useVoiceInput() {
  return {
    supported,
    listening,
    error,
    mode,
    interimText,
    finalText,
    startHandsfree,
    stopHandsfree,
    startTap,
    stopTap,
    toggle,
    extendSilence,
    onFinal,
    onSubmit,
  }
}
