<script setup lang="ts">
// src/components/DiffSummary.vue
//
// Compact summary chips that sit between the comparison preview and
// the result list. Renders one block per change category
// (Hozzáadva / Módosítva / Törölve / Egyéb) with the real count.
//
// We deliberately do NOT show fake "restorable" totals — the badge
// is only shown when the count is > 0. When the total is 0, the
// block stays mounted so the page layout doesn't jump while loading,
// but it reads "0" with a slightly muted colour.
//
// Colours (chosen to read against both dark and light tokens):
//   added     → success (green)
//   modified  → warning  (amber)
//   deleted   → danger   (rose)
//   other     → accent   (brand purple)
import { computed } from 'vue'
import type { DiffChange } from '@/lib/api'
import { countByCategory } from '@/lib/diff'
import type { DiffCategory } from '@/lib/diff'

const props = defineProps<{
  changes: ReadonlyArray<DiffChange>
  /** Optional: how many of the loaded changes are flagged as
   *  restorable. Only the wire shape knows this — for the current
   *  /api/diff stub the value is always 0. Pass `null` to hide the
   *  block. */
  restorableCount?: number | null
}>()

const counts = computed(() => countByCategory(props.changes))
const total = computed(() => props.changes.length)

const blocks: ReadonlyArray<{
  value: DiffCategory
  label: string
  testid: string
  activeClasses: string
  emptyClasses: string
}> = [
  {
    value: 'added',
    label: 'Hozzáadva',
    testid: 'summary-added',
    activeClasses: 'bg-success/10 text-success border-success/30',
    emptyClasses: 'bg-surface text-text-muted border-border-subtle',
  },
  {
    value: 'modified',
    label: 'Módosítva',
    testid: 'summary-modified',
    activeClasses: 'bg-warning/10 text-warning border-warning/30',
    emptyClasses: 'bg-surface text-text-muted border-border-subtle',
  },
  {
    value: 'deleted',
    label: 'Törölve',
    testid: 'summary-deleted',
    activeClasses: 'bg-danger/10 text-danger border-danger/30',
    emptyClasses: 'bg-surface text-text-muted border-border-subtle',
  },
  {
    value: 'other',
    label: 'Egyéb',
    testid: 'summary-other',
    activeClasses: 'bg-nct-500/10 text-text-primary border-nct-soft/30',
    emptyClasses: 'bg-surface text-text-muted border-border-subtle',
  },
]

const showRestorable = computed(
  () => typeof props.restorableCount === 'number' && props.restorableCount > 0,
)
</script>

<template>
  <section
    class="px-4 md:px-6 py-4 border-b border-border-subtle bg-surface/40"
    aria-labelledby="diff-summary-heading"
    data-testid="diff-summary"
  >
    <div class="max-w-[1200px]">
      <h2
        id="diff-summary-heading"
        class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-3"
      >
        Változások összesítése
      </h2>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 md:gap-3" role="list">
        <div
          v-for="b in blocks"
          :key="b.value"
          role="listitem"
          class="flex flex-col gap-0.5 px-3 py-2.5 rounded-md border transition-colors duration-150"
          :class="counts[b.value] > 0 ? b.activeClasses : b.emptyClasses"
          :data-testid="b.testid"
        >
          <span class="text-[10px] font-mono uppercase tracking-wider">
            {{ b.label }}
          </span>
          <span class="text-xl md:text-2xl font-semibold tabular-nums leading-none">
            {{ counts[b.value] }}
          </span>
        </div>
      </div>

      <p class="mt-3 text-[12px] text-text-muted">
        <span class="font-mono text-text-primary">{{ total }}</span> rekord
        a megadott időablakban.
        <span v-if="showRestorable" class="ml-2">
          <span class="font-mono text-text-primary">{{ restorableCount }}</span>
          visszaállíthatónak jelölt.
        </span>
        <span v-else class="ml-2 text-text-muted">
          A visszaállítás a jelenlegi API-n nincs engedélyezve.
        </span>
      </p>
    </div>
  </section>
</template>
