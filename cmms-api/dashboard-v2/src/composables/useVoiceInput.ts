// src/composables/useVoiceInput.ts
//
// Hungarian dictation for the Ask bar (feature #5 of the 2026-08-19
// Ask redesign). Wraps the Web Speech API:
//
//   window.SpeechRecognition || window.webkitSpeechRecognition
//
// with lang = 'hu-HU', interimResults = true, continuous = false. The
// mic button in AskBar calls toggle(); final transcripts stream to the
// registered onFinal callbacks (AskPage appends them to the input),
// and error events surface as a toast.
//
// Graceful degradation: when the browser has no SpeechRecognition at
// all (Firefox, older Safari), `supported` stays false and AskBar
// hides the mic button entirely.

import { onBeforeUnmount, ref } from 'vue'

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
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
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

let recognition: SpeechRecognitionLike | null = null
let manualStop = false
const finalListeners: Array<(text: string) => void> = []

function onFinal(cb: (text: string) => void): () => void {
  finalListeners.push(cb)
  return () => {
    const i = finalListeners.indexOf(cb)
    if (i >= 0) finalListeners.splice(i, 1)
  }
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
  rec.continuous = false
  rec.maxAlternatives = 1

  rec.onresult = (ev: SpeechRecognitionEventLike) => {
    error.value = null
    const finals: string[] = []
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const res = ev.results[i]!
      if (res.isFinal) finals.push(res[0]?.transcript ?? '')
    }
    if (finals.length > 0) {
      for (const cb of finalListeners) cb(finals.join(' '))
    }
  }

  rec.onend = () => {
    listening.value = false
    recognition = null
  }

  rec.onerror = (ev: { error: string }) => {
    listening.value = false
    switch (ev.error) {
      case 'no-speech':
        error.value = 'Nem hallottam semmit. Próbáld újra a mikrofonnal.'
        break
      case 'not-allowed':
      case 'service-not-allowed':
        error.value = 'A mikrofon használata le van tiltva a böngészőben.'
        break
      case 'audio-capture':
        error.value = 'Nincs mikrofon a készüléken.'
        break
      case 'network':
        error.value = 'A beszédfelismerés hálózati hibát észlelt. Próbáld újra.'
        break
      default:
        error.value = 'A beszédfelismerés nem működött. Próbáld újra.'
        break
    }
    recognition = null
  }

  recognition = rec
  return rec
}

function start(): void {
  if (listening.value) return
  const rec = ensureRecognition()
  if (!rec) return
  manualStop = false
  error.value = null
  try {
    rec.start()
    listening.value = true
  } catch {
    // Already started / unsupported — treat as not listening.
    listening.value = false
  }
}

function stop(): void {
  if (!recognition) {
    listening.value = false
    return
  }
  manualStop = true
  try {
    recognition.stop()
  } catch {
    recognition = null
    listening.value = false
  }
}

function toggle(): void {
  if (listening.value) stop()
  else start()
}

onBeforeUnmount(() => {
  if (recognition) {
    try {
      recognition.abort()
    } catch {
      // ignore
    }
    recognition = null
    listening.value = false
  }
})

export function useVoiceInput() {
  return { supported, listening, error, start, stop, toggle, onFinal }
}
