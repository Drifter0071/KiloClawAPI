<script setup lang="ts">
// src/components/VoiceDictationSheet.vue
//
// Hands-free voice dictation bottom sheet (mobile-first, 2026-08-24).
//
// Triggered by a long-press / dedicated "Kéz használata nélkül" affordance
// from AskPage. While `open` is true:
//   - The sheet slides up from the bottom safe area
//   - The mic stays on (continuous SpeechRecognition, hu-HU)
//   - Live interim transcript streams in real time
//   - A visible countdown ring (1.0 → 0.0) shows the silence window
//     so the user knows when the sheet will auto-submit. The ring
//     resets every time the recogniser streams an interim or final.
//   - After 2.5s of no transcript activity, auto-submits
//   - Big "Stop & küldés" button forces immediate submit
//   - "Mégse" discards the buffer
//   - "Több idő" (More time) chip resets the countdown without
//     forcing submit — useful when the user wants to compose a
//     multi-sentence question.
//
// Closes itself on submit (parent flips `open` to false via v-model).
// On mobile the sheet is full-width; on md+ it pins to the bottom of
// the viewport with rounded top corners and a max width.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useVoiceInput, HANDSFREE_SILENCE_MS } from '@/composables/useVoiceInput'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** Submit affordance label. Shown on the primary action. */
    submitLabel?: string
    /** Title shown in the sheet header. */
    title?: string
  }>(),
  {
    submitLabel: 'Stop & küldés',
    title: 'Diktálás (magyar)',
  },
)

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'submit', text: string): void
}>()

const voice = useVoiceInput()
const supported = computed(() => voice.supported.value)
const listening = computed(() => voice.listening.value)
const interimText = computed(() => voice.interimText.value)
const finalText = computed(() => voice.finalText.value)
const errorText = computed(() => voice.error.value)

const livePreview = computed(() => {
  const tail = interimText.value.trim()
  if (!tail) return finalText.value
  return finalText.value
    ? `${finalText.value} ${tail}`.replace(/\s+/g, ' ').trim()
    : tail
})

/** SVG circle circumference for the countdown ring (r=16). */
const circumference = 2 * Math.PI * 16

// Body scroll lock while the sheet is open on mobile.
const isLocked = ref(false)
function lockScroll(lock: boolean) {
  if (typeof document === 'undefined') return
  if (lock && !isLocked.value) {
    document.body.style.overflow = 'hidden'
    isLocked.value = true
  } else if (!lock && isLocked.value) {
    document.body.style.overflow = ''
    isLocked.value = false
  }
}

// ---------------------------------------------------------------------------
// Countdown ring — visualises the silence window so the user can see
// when the sheet will auto-submit. 1.0 = full ring (just heard
// something), 0.0 = empty (about to submit). Resets to 1.0 every time
// the composable arms a new silence timer (which happens on every
// `onresult` event in hands-free mode).
// ---------------------------------------------------------------------------
const silenceProgress = ref(1)
let lastTranscriptActivity = Date.now()
let rafId: number | null = null

function tickRing() {
  if (!props.open) return
  const elapsed = Date.now() - lastTranscriptActivity
  const remaining = Math.max(0, HANDSFREE_SILENCE_MS - elapsed)
  silenceProgress.value = remaining / HANDSFREE_SILENCE_MS
  if (remaining > 0) {
    rafId = requestAnimationFrame(tickRing)
  }
}

function noteTranscriptActivity() {
  lastTranscriptActivity = Date.now()
  silenceProgress.value = 1
}

// When the composable's finalText or interimText changes, treat it as
// activity and reset the ring.
watch(
  [() => voice.finalText.value, () => voice.interimText.value],
  () => {
    if (props.open) noteTranscriptActivity()
  },
)

watch(
  () => props.open,
  (next) => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (next) {
      lastTranscriptActivity = Date.now()
      silenceProgress.value = 1
      rafId = requestAnimationFrame(tickRing)
    } else {
      silenceProgress.value = 1
    }
  },
)

function onMoreTime() {
  // Push the activity timestamp forward by the full window so the
  // user gets another HANDSFREE_SILENCE_MS to compose. Useful when
  // dictating a long multi-sentence question. Re-arms the
  // composable's internal silence timer too.
  noteTranscriptActivity()
  voice.extendSilence()
}

watch(
  () => props.open,
  (next) => {
    lockScroll(next)
    if (next) {
      if (!supported.value) {
        // Shouldn't happen — parent gates the mic button on supported.
        emit('update:open', false)
        return
      }
      voice.startHandsfree()
    } else {
      // Parent closed the sheet — make sure we tear down.
      voice.stopHandsfree(false)
    }
  },
)

function onSubmitClick() {
  const text = finalText.value.trim()
  if (text.length === 0) {
    // No transcript yet — treat as cancel.
    emit('update:open', false)
    return
  }
  emit('submit', text)
  emit('update:open', false)
}

function onCancel() {
  emit('update:open', false)
}

function onClose() {
  emit('update:open', false)
}

// Listen for the silence/timeout auto-submit fired by the composable.
const unsubSubmit = voice.onSubmit((text) => {
  // Only auto-submit if our sheet is the one open.
  if (!props.open) return
  if (text.length === 0) {
    // Nothing captured — just close.
    emit('update:open', false)
    return
  }
  emit('submit', text)
  emit('update:open', false)
})

onBeforeUnmount(() => {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  lockScroll(false)
  unsubSubmit()
  if (props.open) voice.stopHandsfree(false)
})
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm flex items-end md:items-end justify-center"
        data-testid="voice-sheet-backdrop"
        @click.self="onClose"
      >
        <Transition
          appear
          enter-active-class="transition-transform duration-200 ease-out"
          enter-from-class="translate-y-full"
          enter-to-class="translate-y-0"
          leave-active-class="transition-transform duration-150 ease-in"
          leave-from-class="translate-y-0"
          leave-to-class="translate-y-full"
        >
          <div
            v-if="open"
            class="w-full md:max-w-md bg-canvas border-t border-x md:border border-border-default md:rounded-t-2xl rounded-t-2xl shadow-2xl shadow-black/50
                   pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 px-4 md:px-5
                   flex flex-col gap-3"
            data-testid="voice-sheet"
            role="dialog"
            aria-modal="true"
            :aria-label="title"
          >
            <!-- Drag handle (mobile) -->
            <div class="md:hidden flex justify-center">
              <div class="w-10 h-1 rounded-full bg-border-strong" aria-hidden="true" />
            </div>

            <!-- Header -->
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span
                  class="relative inline-flex items-center justify-center w-9 h-9 rounded-full"
                  :class="listening ? 'bg-danger/15 text-danger' : 'bg-surface-2 text-text-muted'"
                  aria-hidden="true"
                >
                  <!-- Countdown ring — SVG circle that drains as the
                       silence window runs out. Resets to full when
                       the recogniser streams a new interim/final. -->
                  <svg
                    v-if="listening"
                    class="absolute inset-0 -rotate-90"
                    width="36" height="36" viewBox="0 0 36 36"
                    data-testid="voice-sheet-countdown"
                  >
                    <circle
                      cx="18" cy="18" r="16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      class="opacity-25"
                    />
                    <circle
                      cx="18" cy="18" r="16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      :stroke-dasharray="circumference"
                      :stroke-dashoffset="circumference * (1 - silenceProgress)"
                      class="transition-[stroke-dashoffset] duration-100 ease-linear"
                    />
                  </svg>
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" :class="listening ? 'animate-nct-pulse' : ''">
                    <rect x="7" y="2.5" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.5" />
                    <path d="M5 10a5 5 0 0 0 10 0M10 15v2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </span>
                <h2 class="text-base font-semibold text-text-primary">
                  {{ title }}
                </h2>
              </div>
              <button
                type="button"
                class="w-9 h-9 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors duration-150
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label="Bezárás"
                data-testid="voice-sheet-close"
                @click="onClose"
              >
                ✕
              </button>
            </div>

            <!-- Live transcript -->
            <div
              class="min-h-[6rem] max-h-[40vh] overflow-y-auto rounded-lg border border-border-subtle bg-surface px-3 py-2.5
                     text-[15px] leading-relaxed text-text-primary"
              data-testid="voice-sheet-transcript"
              aria-live="polite"
              aria-atomic="false"
            >
              <span v-if="!livePreview" class="text-text-muted italic">
                Beszélj most… ({{ Math.round(HANDSFREE_SILENCE_MS / 100) / 10 }} mp csend után automatikusan küldöm)
              </span>
              <template v-else>
                <span>{{ finalText }}<span v-if="finalText && interimText.trim()"> </span></span>
                <span
                  v-if="interimText.trim()"
                  class="text-text-muted"
                  data-testid="voice-sheet-interim"
                >{{ interimText }}</span>
              </template>
            </div>

            <!-- Error banner (no-speech, not-allowed, etc.) -->
            <div
              v-if="errorText"
              class="text-[13px] text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2"
              data-testid="voice-sheet-error"
              role="status"
            >
              {{ errorText }}
            </div>

            <!-- "Több idő" affordance — lets the user explicitly
                 extend the silence window when dictating a long
                 multi-sentence question. Resets the countdown ring
                 and the composable's internal timer. -->
            <div class="flex items-center justify-center -mt-1">
              <button
                type="button"
                class="h-7 px-2.5 rounded-full text-[11.5px] text-text-muted
                       hover:text-text-primary hover:bg-surface-2 transition-colors duration-150
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                       inline-flex items-center gap-1"
                data-testid="voice-sheet-more-time"
                @click="onMoreTime"
              >
                <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5" />
                  <path d="M10 6v4l2.5 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <span>Több idő</span>
              </button>
            </div>

            <!-- Action row -->
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="h-12 min-w-[88px] flex-1 rounded-lg border border-border-default bg-surface-2 text-text-primary font-medium
                       hover:bg-surface-3 transition-colors duration-150
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                data-testid="voice-sheet-cancel"
                @click="onCancel"
              >
                Mégse
              </button>
              <button
                type="button"
                class="h-12 min-w-[88px] flex-1 rounded-lg bg-danger text-white font-semibold
                       hover:bg-danger/90 transition-colors duration-150
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40
                       inline-flex items-center justify-center gap-2"
                data-testid="voice-sheet-submit"
                @click="onSubmitClick"
              >
                <span
                  v-if="listening"
                  class="inline-block w-2.5 h-2.5 rounded-full bg-white animate-nct-blink"
                  aria-hidden="true"
                />
                <span>{{ submitLabel }}</span>
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
