<script setup lang="ts">
// src/components/DiffFilters.vue
//
// Compact segmented filter row that sits above the result list.
// Operators can narrow the visible changes to a single category
// (Hozzáadva / Módosítva / Törölve / Egyéb / Mind).
//
// We use real counts from the loaded changes, NOT a separate API
// call. The "Mind" button shows the total. Categories with 0
// changes are still rendered so the segmented control feels stable
// across refetches.
import { computed } from 'vue'
import type { DiffChange } from '@/lib/api'
import { countByCategory, DIFF_CATEGORIES } from '@/lib/diff'
import type { DiffCategory } from '@/lib/diff'

const props = defineProps<{
  changes: ReadonlyArray<DiffChange>
  selected: DiffCategory | 'all'
}>()

const emit = defineEmits<{
  (e: 'update:selected', value: DiffCategory | 'all'): void
}>()

const counts = computed(() => countByCategory(props.changes))
const total = computed(() => props.changes.length)

const options = computed(() => {
  const cats: ReadonlyArray<DiffCategory> = DIFF_CATEGORIES.map((c) => c.value)
  const items: Array<{
    value: DiffCategory | 'all'
    label: string
    count: number
    testid: string
  }> = [
    { value: 'all', label: 'Mind', count: total.value, testid: 'filter-all' },
  ]
  for (const c of cats) {
    items.push({
      value: c,
      label: DIFF_CATEGORIES.find((d) => d.value === c)!.label,
      count: counts.value[c],
      testid: `filter-${c}`,
    })
  }
  return items
})

function select(value: DiffCategory | 'all') {
  if (value !== props.selected) emit('update:selected', value)
}
</script>

<template>
  <div
    class="px-4 md:px-6 py-2.5 border-b border-border-subtle bg-surface/60"
    role="group"
    aria-label="Szűrés kategória szerint"
    data-testid="diff-filters"
  >
    <div class="max-w-[1200px] flex items-center gap-2 overflow-x-auto -mx-1 px-1">
      <span class="text-[11px] text-text-muted shrink-0 pr-1">Szűrő:</span>
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        class="shrink-0 h-7 inline-flex items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
        :class="
          selected === opt.value
            ? 'bg-nct-500/15 border-nct-soft text-text-primary'
            : 'bg-surface border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-2'
        "
        :aria-pressed="selected === opt.value"
        :disabled="opt.value !== 'all' && opt.count === 0"
        :data-testid="opt.testid"
        @click="select(opt.value)"
      >
        <span>{{ opt.label }}</span>
        <span
          class="font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded-sm"
          :class="
            selected === opt.value
              ? 'bg-nct-500/30 text-text-primary'
              : 'bg-canvas-2 text-text-muted'
          "
        >
          {{ opt.count }}
        </span>
      </button>
    </div>
  </div>
</template>
