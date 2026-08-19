<script setup lang="ts">
// src/components/tokens/EventBadge.vue
//
// Phase 5.5 — semantic event badge for the audit table.
//
//   - Reads label / tone / icon from `eventGrammar.ts`.
//   - Renders an inline icon + the Hungarian label in a pill.
//   - `data-action` and `data-tone` attrs are the test contract: tests
//     assert these, not Tailwind color classes, so the look can change
//     without breaking tests.

import { computed } from 'vue'
import { getEventGrammar, type EventTone } from './eventGrammar'

const props = withDefaults(
  defineProps<{
    /** Server action string, e.g. "login" or "token_rotate_request". */
    action: string
    /** Optional: override the grammar-resolved label (rare). */
    label?: string
  }>(),
  { label: undefined },
)

const grammar = computed(() => getEventGrammar(props.action))
const tone = computed<EventTone>(() => grammar.value.tone)
const display = computed(() => props.label ?? grammar.value.label)

const toneClasses = computed<Record<EventTone, string>>(() => ({
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  neutral: 'bg-surface-2 text-text-secondary',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  brand: 'bg-accent/10 text-accent',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
}))

const classes = computed(() => [
  'inline-flex h-5 items-center gap-1.5 rounded-full px-2',
  'font-medium text-[11px] tracking-wide whitespace-nowrap',
  toneClasses.value[tone.value],
])
</script>

<template>
  <span
    :class="classes"
    :data-action="action"
    :data-tone="tone"
    data-testid="audit-badge"
  >
    <!-- Tiny inline dot icon, color = current text color so it stays
         tonal and high-contrast. 12x12 grid fits the 20px badge height. -->
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 12 12"
      class="w-2.5 h-2.5 shrink-0"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <!-- The path depends on the resolved icon name. Keep it tiny so
           it doesn't out-shout the label. -->
      <template v-if="grammar.icon === 'login'">
        <path d="M7.5 9.5V10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v.5" />
        <path d="M5 6h6" />
        <path d="m9 4 2 2-2 2" />
      </template>
      <template v-else-if="grammar.icon === 'logout'">
        <path d="M7.5 9.5V10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v.5" />
        <path d="M11 6H5" />
        <path d="m3 4-2 2 2 2" />
      </template>
      <template v-else-if="grammar.icon === 'question'">
        <circle cx="6" cy="6" r="4.5" />
        <path d="M5 5.2c0-.9.7-1.5 1.6-1.5.9 0 1.6.6 1.6 1.4 0 .8-.6 1.1-1.2 1.4-.4.2-.5.5-.5.9" />
        <circle cx="6.5" cy="9" r="0.4" fill="currentColor" stroke="none" />
      </template>
      <template v-else-if="grammar.icon === 'answer'">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h5A1.5 1.5 0 0 1 10 4.5v3A1.5 1.5 0 0 1 8.5 9h-3L3 10.5V9H3.5A1.5 1.5 0 0 1 2 7.5z" />
      </template>
      <template v-else-if="grammar.icon === 'shield'">
        <path d="M6 1.5 2 3v3.5C2 8 3.7 9.7 6 10.5 8.3 9.7 10 8 10 6.5V3z" />
      </template>
      <template v-else-if="grammar.icon === 'rotate'">
        <path d="M2 6a4 4 0 0 1 7-2.6" />
        <path d="M9 1.5v2h-2" />
        <path d="M10 6a4 4 0 0 1-7 2.6" />
        <path d="M3 10.5v-2h2" />
      </template>
      <template v-else-if="grammar.icon === 'ban'">
        <circle cx="6" cy="6" r="4.5" />
        <path d="m2.8 2.8 6.4 6.4" />
      </template>
      <template v-else>
        <circle cx="6" cy="6" r="1.2" fill="currentColor" stroke="none" />
      </template>
    </svg>
    <span>{{ display }}</span>
  </span>
</template>
