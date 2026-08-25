// src/composables/useVoiceInput.ts
//
// Hungarian dictation for the Ask bar. Two entry points, ONE behaviour
// model — GBoard-style continuous listening (2026-08-25):
//
//   - "tap"        — the AskBar 40×40 mic is now a TOGGLE, not a
//                   single-shot. Tap once: the mic stays on across
//                   words, pauses and sentence finals; every finalized
//                   fragment streams into the composer incrementally.
//                   Tap again (or hit Küldés): the mic turns off and
//                   any in-flight interim is flushed so the tail of
//                   the last phrase is never lost.
//                   The earlier "stop after the very first final"
//                   behaviour was the 2026-08-25 bug: Chrome finalizes
//                   aggressively on micro-pauses, so "kritikus hiba"
//                   came back as "kritik" + instant stop.
//
//   - "handsfree"  — same continuous engine inside VoiceDictationSheet:
//                   the user dictates across sentences and finishes by
//                   tapping the big "Stop & küldés" button. The session
//                   also auto-ends after `MAX_HANDSFREE_SECONDS`
//                   (default 120s) so a forgotten open mic never runs
//                   the battery flat or streams to Google's servers
//                   forever.
//
//                   (No silence auto-submit anywhere. Earlier revisions
//                   fired after 1.2s / 2.5s / 5s of silence — the user
//                   feedback on 2026-08-24 was unambiguous: "stops after
//                   1 word, should work like GBoard". GBoard never
//                   auto-submits on silence.)
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

/** Hard cap on a single hands-free session. The user must tap the
 *  "Stop & küldés" button to submit sooner; the cap is the safety
 *  net for a forgotten open mic. */
export const MAX_HANDSFREE_SECONDS = 120

/**
 * Chrome (desktop + Android) has a long-standing quirk where the SAME
 * finalized result gets DELIVERED TWICE — either as two back-to-back
 * `onresult` events repeating the resultIndex just before `onend`, or
 * as an instant "replay" of the previous session's last final in the
 * first event of the re-armed session. With the incremental-fragment
 * contract every dictated phrase landed TWICE in the composer
 * (reported 2026-08-25). Two guards:
 *
 *   1. Per-recognition-instance Set of already-finalized indices — a
 *      given result index finalizes exactly once per session, so a
 *      repeated final at the same index is always a replay.
 *   2. Byte-identical consecutive-final check across instances — the
 *      re-armed session starts at index 0, so only text equality
 *      within `REPLAY_DEDUP_WINDOW_MS` catches it.
 *
 * Tradeoff: a deliberate repetition spoken as TWO separate finals
 * within the window ("nem." … "nem.") is merged. Genuinely repeated
 * words almost always arrive inside ONE final ("nem nem"), so this is
 * rarer than the bug itself — accepted.
 */
export const REPLAY_DEDUP_WINDOW_MS = 2000
let lastFinalDelivered = ''
let lastFinalDeliveredAt = 0

function isReplayedFinal(trimmed: string): boolean {
  return (
    trimmed === lastFinalDelivered &&
    Date.now() - lastFinalDeliveredAt < REPLAY_DEDUP_WINDOW_MS
  )
}

function rememberDeliveredFinal(trimmed: string) {
  lastFinalDelivered = trimmed
  lastFinalDeliveredAt = Date.now()
}

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
// True from startRecognition() until an explicit stop/cancel/submit.
// Guards the onend re-arm: a scheduled re-arm callback must not
// resurrect the mic after the user already tapped it off (the mode
// ref is reset to 'tap' by cleanup, so it can't be used for this).
let sessionActive = false
let hardCapTimer: ReturnType<typeof setTimeout> | null = null
const finalListeners: Array<(text: string) => void> = []
const submitListeners: Array<(text: string) => void> = []
const modeListeners: Array<(m: VoiceMode) => void> = []

function clearHardCapTimer() {
  if (hardCapTimer) {
    clearTimeout(hardCapTimer)
    hardCapTimer = null
  }
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
    sessionStartedAt.value = Date.now()
  }

  // A result index finalizes exactly ONCE per recognition instance.
  // Chrome sometimes re-delivers an already-finalized index right
  // before onend — without this Set the fragment would be appended
  // twice (the 2026-08-25 "words appear twice" bug, shape #1).
  const finalizedIdx = new Set<number>()

  rec.onresult = (ev: SpeechRecognitionEventLike) => {
    error.value = null
    let interim = ''
    let newFinals = ''
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const res = ev.results[i]!
      const transcript = res[0]?.transcript ?? ''
      if (res.isFinal) {
        const trimmed = transcript.trim()
        // Guard #1: same-instance re-delivery of a finalized index.
        // Guard #2: cross-instance replay (re-armed session re-emits
        // the previous session's last final at ITS index 0) — caught
        // by byte-identical text within REPLAY_DEDUP_WINDOW_MS.
        if (
          trimmed.length > 0 &&
          !finalizedIdx.has(i) &&
          !isReplayedFinal(trimmed)
        ) {
          finalizedIdx.add(i)
          rememberDeliveredFinal(trimmed)
          finalText.value = finalText.value
            ? `${finalText.value} ${trimmed}`.replace(/\s+/g, ' ').trim()
            : trimmed
          newFinals = newFinals ? `${newFinals} ${trimmed}` : trimmed
        }
      } else {
        interim += transcript
      }
    }
    interimText.value = interim
    if (mode.value === 'handsfree') {
      // No silence auto-submit. GBoard-style: the user dictates until
      // they're happy, then taps "Stop & küldés" (or the hard cap
      // fires after MAX_HANDSFREE_SECONDS). Interims stream live to
      // the sheet's preview; finals get appended to the buffer.
    } else if (newFinals.length > 0 && !manualStop) {
      // tap mode — continuous (GBoard-style, 2026-08-25). Do NOT stop;
      // hand each finalized fragment to consumers incrementally so the
      // composer grows as the user speaks. Chrome finalizes early on
      // micro-pauses ("kritikus hiba" → final "kritik"), so stopping
      // here used to cut the utterance in half.
      for (const cb of finalListeners) cb(newFinals)
    }
  }

  rec.onend = () => {
    listening.value = false
    recognition = null
    if (sessionActive && !manualStop) {
      // Some browsers (Chrome desktop) end after each `isFinal` even
      // with `continuous = true`. Re-arm in BOTH modes while the user
      // hasn't stopped and the hard cap hasn't expired.
      const start = sessionStartedAt.value
      if (start && Date.now() - start < MAX_HANDSFREE_SECONDS * 1000) {
        // Tiny backoff to avoid a hot loop if onend fires repeatedly.
        setTimeout(() => {
          if (sessionActive && !manualStop && !recognition) {
            startRecognition('rearm')
          }
        }, 80)
      } else {
        // Hard cap reached — finish the session the way its mode does.
        if (mode.value === 'handsfree') submitHandsfree('timeout')
        else stopTap()
      }
    } else if (mode.value === 'handsfree' && manualStop) {
      // User tapped "Stop & küldés" or cancelled.
      cleanup('manual')
    } else {
      // Wind-down after an explicit stop (stopTap already flushed the
      // buffers); just retire the cap timer.
      clearHardCapTimer()
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

function submitHandsfree(reason: 'manual' | 'timeout') {
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
  sessionActive = false
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
  sessionActive = true
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
  // Hard cap: stop after MAX_HANDSFREE_SECONDS no matter what. The
  // user can submit sooner by tapping "Stop & küldés". No silence
  // auto-submit (GBoard-style).
  clearHardCapTimer()
  hardCapTimer = setTimeout(() => {
    submitHandsfree('timeout')
  }, MAX_HANDSFREE_SECONDS * 1000)
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
  // Same safety cap as hands-free: a forgotten open tap-mic must not
  // stream forever. stopTap() is the correct teardown for tap mode —
  // it flushes the in-flight interim before resetting.
  clearHardCapTimer()
  hardCapTimer = setTimeout(() => {
    if (mode.value === 'tap' && sessionActive) stopTap()
  }, MAX_HANDSFREE_SECONDS * 1000)
}

function stopTap(): void {
  if (mode.value !== 'tap') return
  // Flush the in-flight interim FIRST so the tail of the last phrase
  // ("…hiba" while Chrome was still deciding) reaches the composer
  // before teardown. Without this, tapping the mic off mid-word eats
  // everything Chrome hadn't finalized yet.
  const tail = interimText.value.trim()
  if (tail.length > 0) {
    promoteInterim()
    for (const cb of finalListeners) cb(tail)
  }
  // Kill re-arms BEFORE touching the recogniser: onend fires
  // synchronously in some browsers/tests once stop() lands, and the
  // scheduled-rearm callback checks these flags at fire time.
  sessionActive = false
  manualStop = true
  clearHardCapTimer()
  if (recognition) {
    try {
      recognition.stop()
    } catch {
      recognition = null
      listening.value = false
    }
  }
  resetBuffers()
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
    onFinal,
    onSubmit,
  }
}
