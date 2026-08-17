<script setup lang="ts">
// src/components/AgentBody.vue
//
// Renders an agentic answer (POST /v1/answer-agent response):
//   - final_text — the LLM's answer, with inline markdown (**bold**,
//     *italic*, `code`) styled AND sorszam tokens clickable
//   - tool-trace chips — every tool the agent called, ok / failed
//   - meta line — iteration count + model
//
// This is the CURRENT Ask path (always on). The legacy AnswerBody only
// renders stored history entries (meta.answer).

import { computed } from 'vue'
import SorszamLink from './SorszamLink.vue'
import type { AnswerAgentResponse } from '@/lib/api'

const props = defineProps<{ data: AnswerAgentResponse }>()

const emit = defineEmits<{
  (e: 'sorszam-click', payload: { prefix: 'B' | 'M'; sorszam: string }): void
}>()

type InlineSeg = { kind: 'plain' | 'bold' | 'italic' | 'code'; text: string }

/** Split final_text into inline-markdown segments (bold/italic/code)
 *  while leaving everything else as plain text. Sorszam tokenization
 *  happens per segment inside SorszamLink, so ids stay clickable even
 *  inside a **bold** run. */
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g

const segments = computed<InlineSeg[]>(() => {
  const out: InlineSeg[] = []
  const text = props.data.final_text
  let last = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'plain', text: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('**')) out.push({ kind: 'bold', text: tok.slice(2, -2) })
    else if (tok.startsWith('`')) out.push({ kind: 'code', text: tok.slice(1, -1) })
    else out.push({ kind: 'italic', text: tok.slice(1, -1) })
    last = m.index + tok.length
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) })
  return out
})
</script>

<template>
  <div data-testid="agent-body">
    <div
      class="text-[15px] text-text-primary leading-relaxed whitespace-pre-wrap"
      data-testid="agent-body-text"
    >
      <template v-for="(seg, i) in segments" :key="i">
        <strong v-if="seg.kind === 'bold'" class="font-semibold">
          <SorszamLink :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
        </strong>
        <em v-else-if="seg.kind === 'italic'" class="italic">
          <SorszamLink :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
        </em>
        <code
          v-else-if="seg.kind === 'code'"
          class="px-1 py-0.5 rounded bg-surface-2 border border-border-subtle font-mono text-[13px]"
        >
          <SorszamLink :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
        </code>
        <SorszamLink v-else :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
      </template>
    </div>

    <!-- Tool trace chips -->
    <div
      v-if="data.tool_trace.length > 0"
      class="mt-3 flex flex-wrap gap-1.5"
      data-testid="agent-trace"
    >
      <span
        v-for="(t, i) in data.tool_trace"
        :key="`${t.name}-${i}`"
        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface-2 border border-border-subtle font-mono text-[10px]"
        :class="t.ok ? 'text-text-secondary' : 'text-danger border-danger/40'"
        :data-testid="`agent-trace-${t.name}`"
        :title="t.ok ? '' : (t.note ?? 'hiba')"
      >
        <span
          class="w-1 h-1 rounded-full shrink-0"
          :class="t.ok ? 'bg-emerald-400' : 'bg-rose-400 animate-pulse'"
        />
        {{ t.name }}
        <span v-if="!t.ok" class="text-[9px]" aria-hidden="true">✗</span>
      </span>
    </div>

    <div
      class="mt-2 flex items-center gap-2 text-[10px] font-mono text-text-muted"
      data-testid="agent-meta"
    >
      <span>{{ data.iterations }} lépés</span>
      <span aria-hidden="true">·</span>
      <span>{{ data.model }}</span>
    </div>
  </div>
</template>
