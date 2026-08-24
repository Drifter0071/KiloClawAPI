<script setup lang="ts">
// src/components/SmartChips.vue
//
// Context-aware one-tap question chips (Phase 8, 2026-08-24, A2 in the
// brainstorm). The AskPage renders these BELOW the AskBar so the
// operator can fire a pre-canned question with one tap instead of
// typing it.
//
// Two layouts:
//   - No device scope   → a row of generic starter chips
//                         ("Melyik ügyfélnek volt a legtöbb kiszállás
//                         idén?", "Mikor volt az utolsó kritikus hiba?")
//   - Device scope set  → chips are tailored to the selected machine:
//                         "M17191 előélet", "M17191 utolsó kiszállás",
//                         "M17191 hibakódok", "M17191 alkatrész stock"
//                         PLUS one "Általános" chip that emits
//                         `__generic__` so the parent can clear the
//                         scope before submitting.
//
// The parent (AskPage) handles the `pick` event by submitting the
// text. For `__generic__` the parent clears the scope and re-uses
// the GENERIC chip text as the actual question.

import { computed } from 'vue'
import { useMachineScope } from '@/composables/useMachineScope'

const emit = defineEmits<{
  (e: 'pick', payload: { text: string; clearScope: boolean }): void
}>()

const { device: scopeDevice } = useMachineScope()

const GENERIC_CHIPS: string[] = [
  'Melyik ügyfélnek volt a legtöbb kiszállás idén?',
  'Melyik gép hibásodik meg a leggyakrabban?',
  'Mikor volt az utolsó kritikus hiba?',
  'Nyitott kritikus ticketek listája',
]

function deviceChips(name: string): string[] {
  const short = name.length > 18 ? name.slice(0, 16) + '…' : name
  return [
    `${short} előélet`,
    `${short} utolsó kiszállás`,
    `${short} hibakódok`,
    `${short} alkatrész stock`,
  ]
}

const chips = computed<string[]>(() => {
  if (scopeDevice.value) {
    return [...deviceChips(scopeDevice.value), 'Általános']
  }
  return GENERIC_CHIPS
})

function pick(text: string): void {
  if (text === 'Általános') {
    // Ask the parent to clear the scope AND substitute the first
    // generic chip as the actual question. The clearScope flag is a
    // hint to AskPage's submitQuestion to NOT pass `context.device`
    // even though `useMachineScope().device` may still hold a stale
    // value for the rest of the session.
    emit('pick', { text: GENERIC_CHIPS[0]!, clearScope: true })
    return
  }
  emit('pick', { text, clearScope: false })
}
</script>

<template>
  <div
    class="flex flex-wrap justify-center gap-2 max-w-2xl mx-auto pt-1"
    data-testid="smart-chips"
  >
    <button
      v-for="chip in chips"
      :key="chip"
      type="button"
      class="h-9 md:h-8 px-3.5 rounded-full
             bg-shell-rail-elevated border border-shell-rail-border
             text-[12.5px] text-chat-read-text/90
             hover:text-chat-read-text hover:border-nct-soft/50
             transition-colors duration-150
             focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
      :data-testid="`smart-chip-${chip}`"
      @click="pick(chip)"
    >
      {{ chip }}
    </button>
  </div>
</template>
