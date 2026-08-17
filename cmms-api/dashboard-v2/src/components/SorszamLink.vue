<script setup lang="ts">
// src/components/SorszamLink.vue
//
// Renders a piece of text with clickable "sorszam" tokens highlighted
// in-line. Used in:
//   - Ask page message bubbles (user + assistant)
//   - AnswerBody result rows + summary line + candidate summaries
//   - Evidence card snippet in the Ask page's evidence card row
//
// The component is the single chokepoint for tokenising sorszam-shaped
// text. Callers branch on the `prefix` field of the emitted payload:
//
//   prefix='B' → ticket sorszam (e.g. B26071801)
//                 → open the right-side TicketPanel and run a
//                   background useApi().answer({sorszam}) to populate
//                   kategoria / sulyossag / snippet / reported_at.
//
//   prefix='M' → device / machine id (e.g. M26057)
//                 → setSeedQ(sorszam) to navigate to /ask and let
//                   the answer primitive resolve the device query.
//                   M-IDs are NOT tickets; opening a TicketPanel for
//                   them is misleading because the wire doesn't have
//                   a device-detail endpoint and the panel would show
//                   "—" for every field.
//
// Patterns matched (see cmms-api/src/db/sorszam.ts for the canonical
// ticket id layout):
//   - B + 7 or 8 digits:  B240326002, B26071801  (ticket sorszam)
//   - M + 4-6 digits:    M26057, M09192        (device / machine id)
//   - Optional -suffix:  M-26057
//
// We deliberately keep the regex conservative. False positives in
// natural Hungarian text are rare because the prefix letters (B / M)
// are followed by 4-8 digits — very few everyday words match.
//
// Emits:
//   sorszamClick({ prefix, sorszam })  — the operator tapped a token.

import { computed } from 'vue'

export type SorszamPrefix = 'B' | 'M'

export interface SorszamClickEvent {
  prefix: SorszamPrefix
  sorszam: string
}

const props = defineProps<{
  text: string
}>()

const emit = defineEmits<{
  (e: 'sorszamClick', payload: SorszamClickEvent): void
}>()

/** Capture-group 1 = the prefix letter, 2 = the digits. */
const SORSZAM_RE = /\b([BM])-?(\d{4,8})\b/g

interface Token {
  text: string
  sorszam?: string
  prefix?: SorszamPrefix
}

/** Split the text into alternating plain-text and sorszam tokens. */
const tokens = computed<Token[]>(() => {
  const out: Token[] = []
  let last = 0
  // Reset the regex state — .test()/exec() are stateful.
  SORSZAM_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SORSZAM_RE.exec(props.text)) !== null) {
    const start = m.index
    if (start > last) {
      out.push({ text: props.text.slice(last, start) })
    }
    const prefix = m[1]!.toUpperCase() as SorszamPrefix
    const digits = m[2]!
    out.push({ text: m[0], sorszam: `${prefix}${digits}`, prefix })
    last = start + m[0].length
  }
  if (last < props.text.length) {
    out.push({ text: props.text.slice(last) })
  }
  return out
})

function onClick(payload: SorszamClickEvent, evt: MouseEvent) {
  evt.preventDefault()
  emit('sorszamClick', payload)
}
</script>

<template>
  <span data-testid="sorszam-link-text">
    <template v-for="(t, i) in tokens" :key="i">
      <button
        v-if="t.sorszam && t.prefix"
        type="button"
        class="font-mono text-accent hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent underline-offset-2 rounded transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :data-testid="`sorszam-link-${t.sorszam}`"
        :data-sorszam-prefix="t.prefix"
        :aria-label="t.prefix === 'B' ? `Ticket ${t.sorszam} megnyitása` : `Gép ${t.sorszam} keresése`"
        @click="(e) => onClick({ prefix: t.prefix!, sorszam: t.sorszam! }, e)"
      >
        {{ t.text }}
      </button>
      <span v-else>{{ t.text }}</span>
    </template>
  </span>
</template>
