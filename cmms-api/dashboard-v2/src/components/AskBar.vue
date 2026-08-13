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

import { computed } from 'vue'

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
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit', value: string): void
}>()

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
  </form>
</template>
