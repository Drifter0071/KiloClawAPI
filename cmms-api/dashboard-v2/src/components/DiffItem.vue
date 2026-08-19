<script setup lang="ts">
// src/components/DiffItem.vue
//
// A single change row in the diff list. Purely presentational — the
// parent (DiffList) decides which change is selected, which
// category filter is active, etc.
//
// We deliberately reuse the existing <DiffBlock> component so the
// `data-testid="diff-block-pre"` contract that the test suite
// (tests/diff.spec.ts) depends on is preserved unchanged. The new
// audit-workspace metadata (category, action, timestamp, snippet,
// before/after) is rendered around it.
import { computed } from 'vue'
import Badge from '@/components/Badge.vue'
import DiffBlock from '@/components/DiffBlock.vue'
import type { DiffChange } from '@/lib/api'
import {
  actionLabel,
  categorizeChange,
  formatHuRelative,
  formatIsoMonospace,
  truncate,
} from '@/lib/diff'
import type { DiffCategory } from '@/lib/diff'

const props = defineProps<{
  change: DiffChange
  selected?: boolean
  /** True when the parent has determined the change is restorable.
   *  Currently always false — see restore logic in DiffPage. */
  restorable?: boolean
  /** Disables the inspector / ticket buttons. Used during a
   *  pending restore. */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'view-ticket', id: string): void
}>()

const category = computed<DiffCategory>(() => categorizeChange(props.change))

const categoryLabel: Record<DiffCategory, string> = {
  added: 'Hozzáadva',
  modified: 'Módosítva',
  deleted: 'Törölve',
  other: 'Egyéb',
}

const categoryTestId: Record<DiffCategory, string> = {
  added: 'category-added',
  modified: 'category-modified',
  deleted: 'category-deleted',
  other: 'category-other',
}

const categoryClass: Record<DiffCategory, string> = {
  added: 'bg-success/15 text-success',
  modified: 'bg-warning/15 text-warning',
  deleted: 'bg-danger/15 text-danger',
  other: 'bg-nct-500/15 text-text-primary',
}

const actionHuman = computed(() => actionLabel(props.change.action))
const actionTestid = computed(() => `diff-action-${props.change.action}`)
const snippet = computed(() => truncate(String(props.change.after ?? ''), 240))
const relativeTime = computed(() => formatHuRelative(props.change.t))
const exactTime = computed(() => formatIsoMonospace(props.change.t))

function onSelect() {
  emit('select', props.change.id)
}
function onViewTicket() {
  emit('view-ticket', props.change.id)
}
</script>

<template>
  <article
    class="px-4 md:px-6 py-4 border-b border-border-subtle last:border-b-0 transition-colors duration-150"
    :class="selected ? 'bg-nct-500/5' : 'hover:bg-surface-2/40'"
    :aria-selected="selected"
    data-testid="diff-entry"
    :data-category="category"
  >
    <!-- Header row: category badge + action + id + timestamp -->
    <div class="flex flex-wrap items-center gap-2 md:gap-3">
      <span
        class="inline-flex items-center gap-1 h-5 rounded-full px-2 font-mono text-[10px] uppercase tracking-wider"
        :class="categoryClass[category]"
        :data-testid="categoryTestId[category]"
      >
        <span aria-hidden="true">●</span>
        <span>{{ categoryLabel[category] }}</span>
      </span>
      <Badge
        :label="change.action"
        :data-testid="'diff-action-badge'"
        :variant="
          change.action === 'approval'
            ? 'warning'
            : change.action === 'answer'
              ? 'info'
              : 'default'
        "
      />
      <span
        class="font-mono text-[12px] text-text-secondary"
        :data-testid="actionTestid"
      >
        {{ change.entity }}
      </span>
      <span
        class="font-mono text-[12px] text-text-primary"
        data-testid="diff-id"
      >
        {{ change.id }}
      </span>
      <span
        class="ml-auto font-mono text-[11px] text-text-muted tabular-nums"
        :title="exactTime"
        data-testid="diff-time"
      >
        {{ exactTime }} · {{ relativeTime }}
      </span>
    </div>

    <!-- Snippet -->
    <p
      v-if="snippet"
      class="mt-2 text-[13px] text-text-secondary leading-relaxed"
      data-testid="diff-snippet"
    >
      {{ snippet }}
    </p>

    <!-- The wire returns `before: null` for the stub, so we render the
         DiffBlock with after only. The existing test asserts that
         `data-testid="diff-block-pre"` is present once per row, and
         DiffBlock emits that testid. -->
    <DiffBlock class="mt-3" :after="String(change.after ?? '')" />

    <!-- Footer actions -->
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
      <span
        v-if="!restorable"
        class="text-[11px] text-text-muted"
        data-testid="diff-restore-note"
      >
        Visszaállítás jelenleg nem elérhető ehhez a rekordhoz.
      </span>
      <span v-else class="text-[11px] text-warning">
        Visszaállítás elérhető — használd a „Visszaállítás" gombot.
      </span>

      <div class="flex items-center gap-3 ml-auto">
        <button
          type="button"
          class="text-[12px] text-text-secondary hover:text-text-primary"
          data-testid="view-details"
          :disabled="busy"
          @click="onSelect"
        >
          {{ selected ? 'Részletek elrejtése' : 'Részletek' }}
        </button>
        <button
          type="button"
          class="text-[12px] text-nct-soft hover:text-text-primary font-medium"
          data-testid="view-ticket"
          :disabled="busy"
          @click="onViewTicket"
        >
          Ticket megnyitása →
        </button>
      </div>
    </div>
  </article>
</template>
