<script setup lang="ts">
// src/components/AskBar.vue
//
// The one shared "ask the CMMS" input used by the Ask page (hero empty
// state) and the Stream page (compact banner).
//
// Variants:
//   - size="lg"  → hero command bar, h-14 rounded-full
//   - size="md"  → compact bar, h-10 rounded-full
//   - rounded="md" → square-ish (currently unused, kept for symmetry)
//
// The submit control is ALWAYS the small "↵" enter-key chip — sitewide
// decision (2026-08-12): the text-pill "Ask"/"Send" button variant was
// removed; the ↵ chip is the single submit affordance everywhere.
//
// `inputId` defaults to "ask-input" so the shell's Cmd/Ctrl+K shortcut
// (useKeyboardShortcuts) can focus it. Only ONE AskBar on a page should
// keep that id — the others must pass a different one.

import { computed, onBeforeUnmount } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    size?: 'lg' | 'md'
    rounded?: 'full' | 'md' | 'lg'
    disabled?: boolean
    busy?: boolean
    inputId?: string
    ariaLabel?: string
    /** Show the Hungarian-dictation mic button (AskPage only). */
    mic?: boolean
    /** True while speech recognition is capturing audio. */
    micListening?: boolean
    /**
     * Long-press / second long-press handler that opens the
     * hands-free dictation sheet (mobile-first feature, 2026-08-24).
     * The button shows a subtle hint when `micHandsFreeHint` is true.
     */
    micHandsFreeHint?: boolean
    /**
     * When true, render the "Háttérben" submit chip next to the
     * ↵ submit affordance. Tapping it emits `submit-background`
     * instead of `submit` — the parent submits via the async
     * /v1/answer-agent/async path so the user can navigate away
     * (Phase 8, 2026-08-24, A9 in the brainstorm).
     */
    background?: boolean
  }>(),
  {
    placeholder: 'Kérdezd a CMMS-t…',
    size: 'md',
    // Default changed in Phase 7: HIG-flavoured square-ish input, not a
    // pill. Existing callers passing `rounded="full"` (none in the app
    // any more) still get the old pill look.
    rounded: 'lg',
    disabled: false,
    busy: false,
    inputId: 'ask-input',
    ariaLabel: 'Kérdezd a CMMS-t',
    mic: false,
    micListening: false,
    micHandsFreeHint: false,
    background: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit', value: string): void
  (e: 'submit-background', value: string): void
  (e: 'mic-toggle'): void
  (e: 'mic-handsfree'): void
}>()

// Background-jobs count (read from the singleton composable; reactive
// so the badge updates the moment a new job is tracked or a result
// lands). Phase 8, 2026-08-24 (F3): the AskBar shows a tiny "n
// fut" badge so the user can see at-a-glance how many questions are
// still cooking in the background.
import { useBackgroundJobs } from '@/composables/useBackgroundJobs'
const { jobs: bgJobs } = useBackgroundJobs()
const runningCount = computed(() => bgJobs.value.filter((j) => j.status === 'running').length)

// ---------------------------------------------------------------------------
// Long-press detection for the hands-free affordance (mobile-first).
// We track touchstart/mousedown + a 450ms threshold; below that, the
// button behaves as before (tap = single-shot dictate). At or above the
// threshold, we emit `mic-handsfree` and swallow the click. The press
// is also cancelled if the pointer leaves the button or is released
// before the threshold (in which case the click handler still fires).
// ---------------------------------------------------------------------------
let pressTimer: ReturnType<typeof setTimeout> | null = null
let longPressFired = false

function clearPressTimer() {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

function onPressStart() {
  if (!props.micHandsFreeHint) return
  longPressFired = false
  clearPressTimer()
  pressTimer = setTimeout(() => {
    longPressFired = true
    emit('mic-handsfree')
  }, 450)
}

function onPressEnd() {
  clearPressTimer()
}

function onPressCancel() {
  clearPressTimer()
}

function onMicClick() {
  if (longPressFired) {
    longPressFired = false
    return
  }
  emit('mic-toggle')
}

onBeforeUnmount(() => {
  clearPressTimer()
})

const canSubmit = computed(() => !props.disabled && !props.busy && props.modelValue.trim().length > 0)

const barClasses = computed(() => [
  'flex items-center gap-2',
  'bg-surface border border-border-default',
  'transition-colors duration-150',
  'focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15',
  'disabled:opacity-50',
  props.size === 'lg' ? 'h-14 px-5' : 'h-10 px-4',
  props.rounded === 'full' ? 'rounded-full' : props.rounded === 'lg' ? 'rounded-lg' : 'rounded-md',
])

function onSubmit() {
  if (canSubmit.value) {
    emit('submit', props.modelValue)
  }
}

function onSubmitBackground() {
  if (canSubmit.value) {
    emit('submit-background', props.modelValue)
  }
}

function onInput(evt: Event) {
  const target = evt.target as HTMLInputElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <form :class="barClasses" data-testid="ask-bar" @submit.prevent="onSubmit">
    <input
      :id="inputId"
      :value="modelValue"
      type="text"
      :placeholder="placeholder"
      :disabled="disabled || busy"
      :aria-label="ariaLabel"
      autocomplete="off"
      spellcheck="false"
      class="flex-1 min-w-0 bg-transparent border-0 outline-none text-text-primary placeholder:text-text-muted focus:ring-0"
      :class="size === 'lg' ? 'text-base' : 'text-sm'"
      data-testid="ask-bar-input"
      @input="onInput"
    />
    <!-- Background-jobs pending badge (Phase 8, 2026-08-24, F3).
         Shows when at least one async question is still running.
         Tooltip explains the meaning; tap is a no-op for now (the
         ConversationRail shows the per-job progress). -->
    <span
      v-if="runningCount > 0"
      class="h-6 px-1.5 rounded-md
             bg-warning/15 border border-warning/30
             text-[10.5px] font-mono font-semibold text-warning
             inline-flex items-center gap-1"
      :title="`${runningCount} kérdés fut a háttérben`"
      data-testid="ask-bar-bg-badge"
      aria-live="polite"
    >
      <svg
        width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true"
        class="animate-nct-pulse"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 5v3.2l2 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span>{{ runningCount }} fut</span>
    </span>
    <!-- Voice input mic (hu-HU dictation). Shown only when the parent
         opts in (`mic`) and the browser supports SpeechRecognition —
         AskPage hides the whole button otherwise. Touch target ≥ 40px. -->
    <button
      v-if="mic"
      type="button"
      :disabled="disabled || busy"
      :aria-label="micListening ? 'Diktálás leállítása' : 'Diktálás magyarul'"
      :aria-pressed="micListening"
      :title="micListening ? 'Leállítás' : 'Diktálás (magyar)'"
      class="relative w-10 h-10 shrink-0 inline-flex items-center justify-center rounded-md
             text-text-secondary hover:text-text-primary hover:bg-surface-2
             transition-colors duration-150
             disabled:opacity-40 disabled:cursor-not-allowed
             focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
             select-none"
      data-testid="ask-bar-mic"
      @click="onMicClick"
      @mousedown="onPressStart"
      @mouseup="onPressEnd"
      @mouseleave="onPressCancel"
      @touchstart.passive="onPressStart"
      @touchend="onPressEnd"
      @touchcancel="onPressCancel"
    >
      <svg
        width="16" height="16" viewBox="0 0 20 20" fill="none"
        :class="micListening ? 'text-danger' : ''"
        aria-hidden="true"
      >
        <rect x="7" y="2.5" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M5 10a5 5 0 0 0 10 0M10 15v2.5"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
        />
      </svg>
      <span
        v-if="micListening"
        class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-danger animate-nct-blink"
        aria-hidden="true"
      />
      <!-- Hands-free hint ring (long-press affordance). -->
      <span
        v-if="micHandsFreeHint && !micListening"
        class="absolute inset-0 rounded-md ring-1 ring-accent/40"
        aria-hidden="true"
      />
    </button>
    <!-- ↵ enter-key chip — the single submit affordance (sitewide) -->
    <button
      v-if="canSubmit || busy"
      type="submit"
      :disabled="!canSubmit"
      :aria-label="busy ? 'Dolgozom…' : 'Kérdés elküldése'"
      class="h-7 min-w-7 px-2 rounded-md bg-surface-2 border border-border-subtle font-mono text-xs text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      data-testid="ask-bar-kbd"
    >
      <span
        v-if="busy"
        class="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        aria-hidden="true"
      />
      <template v-else>↵</template>
    </button>
    <!-- "Háttérben" submit chip (Phase 8, 2026-08-24, A9 in the
         brainstorm). Sibling to the ↵ chip; only renders when the
         parent opts in (`background`). Tap to fire the question via
         the async /v1/answer-agent/async endpoint and free the
         user to navigate away. The answer lands later as a fresh
         assistant bubble + a toast. -->
    <button
      v-if="background && canSubmit && !busy"
      type="button"
      :aria-label="'Háttérben küldés — értesítünk ha kész'"
      :title="'Háttérben fut, értesítünk'"
      class="h-7 px-2 rounded-md bg-surface-2 border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 inline-flex items-center gap-1"
      data-testid="ask-bar-background"
      @click="onSubmitBackground"
    >
      <svg
        width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M8 5v3.2l2 1.4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="text-[11px] font-medium">Háttérben</span>
    </button>
  </form>
</template>
