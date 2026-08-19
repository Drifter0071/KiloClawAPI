<script setup lang="ts">
// src/components/AgentBody.vue
//
// Renders an agentic answer (POST /v1/answer-agent response):
//   - final_text — the LLM's answer, with inline markdown (**bold**,
//     *italic*, `code`) styled AND sorszam tokens clickable
//   - GFM pipe-tables — when the LLM emits a Markdown table
//     (| col | col | / |---|---| / | a | b |) it is rendered as a real
//     <table> instead of monospaced text. Header row + alignment
//     separators drive the layout, body cells keep inline markdown
//     and clickable sorszam tokens.
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

/** Split a chunk of text into inline-markdown segments (bold/italic/code)
 *  while leaving everything else as plain text. Sorszam tokenization
 *  happens per segment inside SorszamLink, so ids stay clickable even
 *  inside a **bold** run. Reused inside table cells. */
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g

function inlineSegments(text: string): InlineSeg[] {
  const out: InlineSeg[] = []
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
}

// ---------------------------------------------------------------------------
// GFM pipe-table parsing
// ---------------------------------------------------------------------------

type Align = 'left' | 'right' | 'center' | null
type Row = string[]
type ParsedTable = { header: Row; aligns: Align[]; rows: Row[] }

/** One table line split into cells. Leading/trailing pipes are stripped
 *  so `| a | b |` and `a | b` both produce `['a', 'b']`. */
function splitRow(line: string): Row {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** Separator line: `|---|---|`, `| :--- | :---: | ---: |` (GFM). Each
 *  cell is `:?-+:?` only. Returns the per-cell alignment or null. */
function parseSeparator(line: string): Align[] | null {
  const cells = splitRow(line)
  if (cells.length === 0) return null
  const out: Align[] = []
  for (const c of cells) {
    const t = c.trim()
    if (!/^:?-+:?$/.test(t)) return null
    const left = t.startsWith(':')
    const right = t.endsWith(':')
    if (left && right) out.push('center')
    else if (right) out.push('right')
    else if (left) out.push('left')
    else out.push(null)
  }
  return out
}

/** Try to parse a block of text as a GFM pipe-table. Returns null when
 *  the block is not a table so the caller falls back to the inline
 *  markdown path. Rules (matching the GitHub-flavoured spec the
 *  Kilo models follow):
 *    - 3+ non-empty lines
 *    - first line is a row, second line is the alignment separator
 *    - at least one body row follows
 *    - every body row has the same cell count as the header
 */
function tryParseTable(block: string): ParsedTable | null {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 3) return null
  const header = splitRow(lines[0]!)
  if (header.length === 0) return null
  const aligns = parseSeparator(lines[1]!)
  if (aligns === null) return null
  if (aligns.length !== header.length) return null
  const rows: Row[] = []
  for (let i = 2; i < lines.length; i += 1) {
    const r = splitRow(lines[i]!)
    if (r.length !== header.length) return null
    rows.push(r)
  }
  if (rows.length === 0) return null
  return { header, aligns, rows }
}

type Block =
  | { kind: 'table'; table: ParsedTable }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'text'; text: string }

/** ATX heading: a line that starts with 1-6 `#` chars followed by
 *  whitespace, then the heading text. The `#`s themselves are not
 *  rendered — only the text becomes the heading, and `**bold**` /
 *  `*italic*` / `` `code` `` inside still apply. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** Split `final_text` into blocks. Blank lines (1+ empty lines) are the
 *  block separator. Each block is then classified as a GFM table, an
 *  ATX heading, or a plain text block. */
const blocks = computed<Block[]>(() => {
  const text = props.data.final_text
  // Split on one-or-more blank lines. The agent's prose is plain
  // `\n` separated, so a regex keeps the table blocks intact (a table
  // row never contains a blank line by spec).
  const raw = text.split(/\n[ \t]*\n+/)
  const out: Block[] = []
  for (const chunk of raw) {
    const trimmed = chunk.trim()
    if (trimmed.length === 0) continue
    const t = tryParseTable(trimmed)
    if (t) {
      out.push({ kind: 'table', table: t })
      continue
    }
    // ATX heading: only when the first non-empty line is a heading.
    // If the block has more lines after the heading, those become a
    // separate text block immediately after (LLMs usually put a
    // blank line after a heading; this is a defensive fallback).
    const firstNewline = chunk.indexOf('\n')
    const firstLine = firstNewline === -1 ? chunk : chunk.slice(0, firstNewline)
    const m = firstLine.match(HEADING_RE)
    if (m) {
      const level = m[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      out.push({ kind: 'heading', level, text: m[2]! })
      if (firstNewline !== -1) {
        const rest = chunk.slice(firstNewline + 1).trim()
        if (rest.length > 0) out.push({ kind: 'text', text: rest })
      }
      continue
    }
    out.push({ kind: 'text', text: trimmed })
  }
  return out
})

/** Inline-markdown segments for a single text block. Each block
 *  re-computes on its own so a table line isn't re-split. */
const textBlockSegments = computed<InlineSeg[][]>(() =>
  blocks.value.map((b): InlineSeg[] => {
    if (b.kind === 'text' || b.kind === 'heading') return inlineSegments(b.text)
    return []
  }),
)

/** Per-cell segments for every table. Outer index: block index, then
 *  (rowIndex, cellIndex, segments). We pre-compute segments so the
 *  template can iterate without a nested computed. */
const tableCellSegments = computed<InlineSeg[][][][]>(() =>
  blocks.value.map((b): InlineSeg[][][] => {
    if (b.kind !== 'table') return []
    const rows: InlineSeg[][][] = []
    for (const r of b.table.rows) {
      const row: InlineSeg[][] = []
      for (const cell of r) row.push(inlineSegments(cell))
      rows.push(row)
    }
    return rows
  }),
)

function alignClass(a: Align): string {
  if (a === 'right') return 'text-right'
  if (a === 'center') return 'text-center'
  return 'text-left'
}
</script>

<template>
  <div data-testid="agent-body">
    <div
      class="text-[15px] text-text-primary leading-relaxed"
      data-testid="agent-body-text"
    >
      <template v-for="(block, bi) in blocks" :key="bi">
        <!-- GFM pipe-table: real <table> with header + alignment -->
        <div
          v-if="block.kind === 'table'"
          class="my-2 overflow-x-auto"
          :data-testid="`agent-body-table-${bi}`"
        >
          <table
            class="min-w-full text-[13px] border-collapse"
            :data-testid="`agent-body-table-element-${bi}`"
          >
            <thead>
              <tr
                class="border-b border-border-subtle/70 bg-surface-2/40"
                :data-testid="`agent-body-table-head-${bi}`"
              >
                <th
                  v-for="(cell, ci) in block.table.header"
                  :key="`h-${ci}`"
                  scope="col"
                  class="px-2.5 py-1.5 font-semibold text-text-primary"
                  :class="alignClass(block.table.aligns[ci] ?? null)"
                  :data-testid="`agent-body-table-th-${bi}-${ci}`"
                >
                  <SorszamLink
                    :text="cell"
                    @sorszam-click="emit('sorszam-click', $event)"
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, ri) in block.table.rows"
                :key="`r-${ri}`"
                class="border-b border-border-subtle/30 last:border-b-0"
                :data-testid="`agent-body-table-row-${bi}-${ri}`"
              >
                <td
                  v-for="(cell, ci) in row"
                  :key="`c-${ci}`"
                  class="px-2.5 py-1.5 align-top"
                  :class="alignClass(block.table.aligns[ci] ?? null)"
                  :data-testid="`agent-body-table-td-${bi}-${ri}-${ci}`"
                >
                  <template
                    v-for="(seg, si) in (tableCellSegments[bi]?.[ri]?.[ci] ?? [])"
                    :key="`s-${si}`"
                  >
                    <strong v-if="seg.kind === 'bold'" class="font-semibold">
                      <SorszamLink
                        :text="seg.text"
                        @sorszam-click="emit('sorszam-click', $event)"
                      />
                    </strong>
                    <em v-else-if="seg.kind === 'italic'" class="italic">
                      <SorszamLink
                        :text="seg.text"
                        @sorszam-click="emit('sorszam-click', $event)"
                      />
                    </em>
                    <code
                      v-else-if="seg.kind === 'code'"
                      class="px-1 py-0.5 rounded bg-surface-2 border border-border-subtle font-mono text-[12px]"
                    >
                      <SorszamLink
                        :text="seg.text"
                        @sorszam-click="emit('sorszam-click', $event)"
                      />
                    </code>
                    <SorszamLink
                      v-else
                      :text="seg.text"
                      @sorszam-click="emit('sorszam-click', $event)"
                    />
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- ATX heading: strip the leading `#`s, render as a sized
             heading. The inner text goes through the same inline
             markdown pipeline as a body line, so **bold**, *italic*,
             and `code` keep working inside the heading. -->
        <component
          v-else-if="block.kind === 'heading'"
          :is="`h${block.level}`"
          :class="[
            'font-semibold text-text-primary mt-3 first:mt-0 mb-1',
            block.level === 1 ? 'text-[19px] leading-snug' : '',
            block.level === 2 ? 'text-[17px] leading-snug' : '',
            block.level === 3 ? 'text-[15.5px] leading-snug' : '',
            block.level >= 4 ? 'text-[14.5px] leading-snug' : '',
          ]"
          :data-testid="`agent-body-heading-${bi}`"
          :data-heading-level="block.level"
        >
          <template v-for="(seg, i) in (textBlockSegments[bi] ?? [])" :key="i">
            <strong v-if="seg.kind === 'bold'" class="font-semibold">
              <SorszamLink
                :text="seg.text"
                @sorszam-click="emit('sorszam-click', $event)"
              />
            </strong>
            <em v-else-if="seg.kind === 'italic'" class="italic">
              <SorszamLink
                :text="seg.text"
                @sorszam-click="emit('sorszam-click', $event)"
              />
            </em>
            <code
              v-else-if="seg.kind === 'code'"
              class="px-1 py-0.5 rounded bg-surface-2 border border-border-subtle font-mono text-[0.9em]"
            >
              <SorszamLink
                :text="seg.text"
                @sorszam-click="emit('sorszam-click', $event)"
              />
            </code>
            <SorszamLink
              v-else
              :text="seg.text"
              @sorszam-click="emit('sorszam-click', $event)"
            />
          </template>
        </component>

        <!-- Plain text block: existing inline-markdown pipeline -->
        <div
          v-else
          class="whitespace-pre-wrap"
          :data-testid="`agent-body-block-${bi}`"
        >
          <template v-for="(seg, i) in (textBlockSegments[bi] ?? [])" :key="i">
            <strong v-if="seg.kind === 'bold'" class="font-semibold">
              <SorszamLink
                :text="seg.text"
                @sorszam-click="emit('sorszam-click', $event)"
              />
            </strong>
            <em v-else-if="seg.kind === 'italic'" class="italic">
              <SorszamLink
                :text="seg.text"
                @sorszam-click="emit('sorszam-click', $event)"
              />
            </em>
            <code
              v-else-if="seg.kind === 'code'"
              class="px-1 py-0.5 rounded bg-surface-2 border border-border-subtle font-mono text-[13px]"
            >
              <SorszamLink
                :text="seg.text"
                @sorszam-click="emit('sorszam-click', $event)"
              />
            </code>
            <SorszamLink
              v-else
              :text="seg.text"
              @sorszam-click="emit('sorszam-click', $event)"
            />
          </template>
        </div>
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
