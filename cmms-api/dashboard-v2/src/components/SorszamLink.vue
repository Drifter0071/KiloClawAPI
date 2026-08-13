<script setup lang="ts">
// src/components/SorszamLink.vue
//
// Renders a piece of text with clickable "sorszam" tokens highlighted
// in-line. Used inside Ask page message bubbles so the operator can
// tap any ticket id (B-sorszam or M-device-id) to open the right-side
// TicketInspector without leaving the chat.
//
// Patterns matched (see cmms-api/src/db/sorszam.ts for the canonical
// ticket id layout):
//   - B + 7 or 8 digits:  B240326002, B26071801  (ticket sorszam)
//   - M + 4-6 digits:    M26057, M09192        (device / machine id)
//   - Optional -suffix:  M-26057
//
// We deliberately keep the regex conservative. False positives in
// natural Hungarian text are rare because the prefix letters (B / M)
// are followed by 4-8 digits — very few everyday words match. If
// something does look like a sorszam but isn't, the click is harmless:
// the inspector opens with the candidate sorszam and shows
// "— Nincs adat" in every field.
//
// Emits:
//   sorszamClick(sorszam)  — the operator tapped a token.

import { computed } from 'vue'

const props = defineProps<{
  text: string
}>()

const emit = defineEmits<{
  (e: 'sorszamClick', sorszam: string): void
}>()

/** Capture-group 1 = the sorszam token. Case-insensitive B/M prefix. */
const SORSZAM_RE = /\b([BM])-?(\d{4,8})\b/g

interface Token {
  text: string
  sorszam?: string
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
    const prefix = m[1]!.toUpperCase()
    const digits = m[2]!
    out.push({ text: m[0], sorszam: `${prefix}${digits}` })
    last = start + m[0].length
  }
  if (last < props.text.length) {
    out.push({ text: props.text.slice(last) })
  }
  return out
})

function onClick(sorszam: string, evt: MouseEvent) {
  evt.preventDefault()
  emit('sorszamClick', sorszam)
}
</script>

<template>
  <span data-testid="sorszam-link-text">
    <template v-for="(t, i) in tokens" :key="i">
      <button
        v-if="t.sorszam"
        type="button"
        class="font-mono text-accent hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent underline-offset-2 rounded transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :data-testid="`sorszam-link-${t.sorszam}`"
        :aria-label="`Ticket ${t.sorszam} megnyitása`"
        @click="(e) => onClick(t.sorszam!, e)"
      >
        {{ t.text }}
      </button>
      <span v-else>{{ t.text }}</span>
    </template>
  </span>
</template>
