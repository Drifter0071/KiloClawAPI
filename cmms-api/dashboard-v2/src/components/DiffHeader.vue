<script setup lang="ts">
// src/components/DiffHeader.vue
//
// Page header for /diff. Title + subtitle + one-line explanation +
// an optional right-aligned meta line (e.g. "last successful load").
// Purely presentational — the page passes in any state it wants to
// show in the meta slot via a prop or the #aside slot.
defineProps<{
  /** Right-aligned metadata text. Hidden when null/empty. */
  meta?: string | null
}>()
</script>

<template>
  <header
    class="px-4 md:px-6 py-4 border-b border-border-subtle bg-canvas-2/40"
    data-testid="diff-header"
  >
    <div class="flex items-start justify-between gap-3 max-w-[1200px]">
      <div class="min-w-0 flex-1">
        <h1
          class="text-[17px] md:text-[19px] font-semibold tracking-tight text-text-primary leading-tight"
        >
          Diff / Visszaállítás
        </h1>
        <p class="mt-1 text-[13px] text-text-secondary leading-relaxed">
          Strukturális változások és auditnapló összehasonlítása
        </p>
        <p class="mt-2 text-[12px] text-text-muted leading-relaxed max-w-2xl">
          Válassz egy korábbi időpontot a jelenlegi állapottal való
          összehasonlításhoz. A „Diff betöltése" gomb futtatja a
          lekérdezést — a bal oldali csempe a korábbi, a jobb oldali a
          jelenlegi állapotot mutatja.
        </p>
      </div>
      <div
        v-if="meta || $slots.aside"
        class="hidden md:flex flex-col items-end gap-1 shrink-0 text-[11px] text-text-muted font-mono"
        data-testid="diff-header-meta"
      >
        <slot name="aside">
          <span v-if="meta">{{ meta }}</span>
        </slot>
      </div>
    </div>
  </header>
</template>
