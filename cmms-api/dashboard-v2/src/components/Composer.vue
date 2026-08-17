<script setup lang="ts">
// src/components/Composer.vue
//
// V2 chat composer — the most important surface in the shell.
//
// A single rounded "bar" with:
//   - a leading brand mark dot (subtle visual anchor)
//   - a textarea that auto-grows 1..4 lines
//   - a trailing send button (becomes a stop-style spinner when busy)
//
// The composer auto-resizes its textarea via a small post-render height
// measurement (no library). It is keyboard accessible: Enter sends,
// Shift+Enter inserts a newline. The send button is disabled until the
// text is non-empty AND we're not already sending.
//
// The `id` is configurable so multiple composers can coexist on the
// page (the empty-state hero uses one id, the docked composer uses
// another) without breaking the Ask page's `document.getElementById`
// focus logic.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    busy?: boolean
    disabled?: boolean
    inputId?: string
    size?: 'lg' | 'md'
    maxRows?: number
  }>(),
  {
    placeholder: 'Kérdezd a NCT Szerviz Ai-t…',
    busy: false,
    disabled: false,
    inputId: 'ask-input',
    size: 'md',
    maxRows: 4,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit', value: string): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const inputWrapRef = ref<HTMLDivElement | null>(null)

// Auto-grow the textarea up to `maxRows` lines. Reset to a single row
// when the user clears the field.
function autoSize() {
  const ta = textareaRef.value
  if (!ta) return
  // Reset to measure scroll height
  ta.style.height = 'auto'
  const cs = window.getComputedStyle(ta)
  const lineHeight = parseFloat(cs.lineHeight) || 20
  const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
  const maxHeight = lineHeight * props.maxRows + padding
  const newHeight = Math.min(ta.scrollHeight, maxHeight)
  ta.style.height = `${newHeight}px`
  ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

watch(
  () => props.modelValue,
  () => {
    nextTick(autoSize)
  },
)

const canSubmit = computed(
  () => !props.disabled && !props.busy && props.modelValue.trim().length > 0,
)

function onInput(evt: Event) {
  const target = evt.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
}

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Enter' && !evt.shiftKey && !evt.isComposing) {
    evt.preventDefault()
    if (canSubmit.value) {
      emit('submit', props.modelValue)
    }
  }
}

function focusInput() {
  nextTick(() => {
    textareaRef.value?.focus()
  })
}

onMounted(() => {
  autoSize()
})
onBeforeUnmount(() => {
  /* nothing to clean up */
})

defineExpose({ focusInput })
</script>

<template>
  <form
    ref="inputWrapRef"
    class="group/composer relative w-full
           bg-shell-composer backdrop-blur-xl
           border border-nct-500/25
           rounded-2xl
           shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_24px_rgba(0,0,0,0.20)]
           transition-colors duration-200
           focus-within:border-nct-500/60 focus-within:ring-2 focus-within:ring-nct-500/15"
    :class="size === 'lg' ? 'py-2.5 pl-4 pr-2.5' : 'py-1.5 pl-3.5 pr-2'"
    data-testid="composer"
    @submit.prevent="canSubmit && emit('submit', modelValue)"
  >
    <!-- Leading brand dot — subtle visual anchor -->
    <span
      class="absolute left-3.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-nct-soft pointer-events-none"
      aria-hidden="true"
    />

    <textarea
      :id="inputId"
      ref="textareaRef"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled || busy"
      :rows="1"
      :aria-label="placeholder"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      class="w-full resize-none bg-transparent border-0 outline-none
             text-chat-read-text placeholder:text-shell-rail-muted
             focus:ring-0
             disabled:opacity-60 disabled:cursor-not-allowed
             leading-6
             scrollbar-thin"
      :class="[
        size === 'lg' ? 'pl-5 text-[15px] min-h-[40px]' : 'pl-5 text-[14px] min-h-[32px]',
      ]"
      data-testid="composer-input"
      @input="onInput"
      @keydown="onKeydown"
    />

    <!-- Trailing: stop-style submit (right-aligned, integrated) -->
    <div class="flex items-end justify-end mt-1 -mb-0.5">
      <button
        type="submit"
        :disabled="!canSubmit"
        :aria-busy="busy || undefined"
        :aria-label="busy ? 'Dolgozom…' : 'Kérdés elküldése'"
        class="inline-flex items-center justify-center
               h-8 px-3 rounded-lg
               text-[12px] font-medium tracking-tight
               transition-colors duration-150
               focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
               disabled:opacity-40 disabled:cursor-not-allowed"
        :class="
          busy
            ? 'bg-nct-500/30 text-nct-soft'
            : canSubmit
              ? 'bg-nct-500 hover:bg-nct-600 text-white'
              : 'bg-shell-rail-hover text-shell-rail-muted'
        "
        data-testid="composer-send"
      >
        <span
          v-if="busy"
          class="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin mr-1.5"
          aria-hidden="true"
        />
        <svg
          v-else
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          class="mr-1.5"
        >
          <path
            d="M3 8h10M9 4l4 4-4 4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="hidden sm:inline">{{ busy ? 'Dolgozom' : 'Küldés' }}</span>
        <span class="sm:hidden" aria-hidden="true">↵</span>
      </button>
    </div>
  </form>
</template>

<style scoped>
.scrollbar-thin {
  scrollbar-width: thin;
  scrollbar-color: rgba(124, 95, 173, 0.4) transparent;
}
.scrollbar-thin::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: rgba(124, 95, 173, 0.4);
  border-radius: 3px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
</style>
