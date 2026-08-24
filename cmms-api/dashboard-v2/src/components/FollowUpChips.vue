<script setup lang="ts">
// src/components/FollowUpChips.vue
//
// Phase 8 (2026-08-24), brainstorm idea A4 — context-aware follow-up
// chips shown UNDER each completed agent answer. The chips are
// deterministically generated from the answer text + machine scope
// (see src/lib/followUps.ts); no LLM call.
//
// Three chips max. Tapping a chip emits `pick` with the chip's full
// question text. The parent (AskPage) forwards the text to
// `submitQuestion(text)` which re-attaches the current machine
// scope automatically.

import { computed } from 'vue'
import { useMachineScope } from '@/composables/useMachineScope'
import { generateFollowUps, type FollowUpChip } from '@/lib/followUps'

const props = defineProps<{
  /** The agent's final_text. We scan it for sorszam / customer / date
   *  references to decide which chips to render. */
  answer: string
  /** Optional answer id — only render chips once the answer is
   *  finalized (no need to recompute while streaming). */
  answerId?: string
}>()

const emit = defineEmits<{ (e: 'pick', text: string): void }>()

const { device: scopeDevice } = useMachineScope()

const chips = computed<FollowUpChip[]>(() => {
  if (!props.answer || props.answer.length < 20) return []
  return generateFollowUps(props.answer, scopeDevice.value)
})

function pick(chip: FollowUpChip): void {
  emit('pick', chip.text)
}
</script>

<template>
  <div
    v-if="chips.length > 0"
    class="flex flex-wrap gap-1.5 mt-2.5"
    data-testid="follow-up-chips"
  >
    <button
      v-for="chip in chips"
      :key="chip.id"
      type="button"
      class="h-7 px-2.5 rounded-full
             bg-surface-2 border border-border-subtle
             text-[11.5px] text-text-secondary
             hover:text-text-primary hover:border-nct-soft/40
             transition-colors duration-150
             focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
             inline-flex items-center gap-1"
      :data-testid="`follow-up-chip-${chip.id}`"
      @click="pick(chip)"
    >
      <svg
        width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"
        class="text-nct-soft"
      >
        <path
          d="M2 6h7M6 3l3 3-3 3"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>{{ chip.text }}</span>
    </button>
  </div>
</template>
