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
//   - Pulsing mic icon shows the mic is hot
//   - The user taps "Stop & küldés" to submit (GBoard behaviour — no
//     auto-submit on silence, the user dictates as long as they want
//     and explicitly stops when done)
//   - "Mégse" discards the buffer
//
// Closes itself on submit (parent flips `open` to false via v-model).
// On mobile the sheet is full-width; on md+ it pins to the bottom of
// the viewport with rounded top corners and a max width.

import { computed, onBeforeUnmount, watch } from 'vue'
import { useVoiceInput } from '@/composables/useVoiceInput'

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

// Body scroll lock while the sheet is open on mobile.
let isLocked = false
function lockScroll(lock: boolean) {
  if (typeof document === 'undefined') return
  if (lock && !isLocked) {
    document.body.style.overflow = 'hidden'
    isLocked = true
  } else if (!lock && isLocked) {
    document.body.style.overflow = ''
    isLocked = false
  }
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

onBeforeUnmount(() => {
  lockScroll(false)
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
                  <!-- Mic icon. When `listening` is true the icon
                       pulses via `animate-nct-pulse` to signal the
                       mic is hot and the user can keep talking. No
                       countdown ring — the user finishes by tapping
                       "Stop & küldés" (GBoard behaviour). -->
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
                Beszélj most… A küldéshez nyomd meg a „Stop &amp; küldés” gombot.
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

            <!-- (No "Több idő" affordance. GBoard-style: the user
                 finishes when they're ready by tapping "Stop &
                 küldés". There is no silence deadline to extend.) -->

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
