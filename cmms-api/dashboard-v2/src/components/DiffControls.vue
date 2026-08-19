<script setup lang="ts">
// src/components/DiffControls.vue
//
// "Összehasonlítás" section — the date/time picker, preset chips,
// and the primary load button.
//
// Behaviour contract (purely presentational — the parent owns the
// reactive picker / activePreset / loading state):
//
//   - Typing in the picker clears the active preset (parent nulls it
//     via the `update:activePreset` event).
//   - Clicking a preset updates the local picker value via
//     `update:pickerValue` AND emits `preset` so the parent can
//     remember which preset is active (for the aria-pressed pill).
//   - The load button is disabled while a request is in flight and
//     shows a loading spinner (the parent passes `loading`).
//
// All copy is in Hungarian. The primary button uses the brand purple
// (nct-500 / nct-soft) so the page feels consistent with the rest of
// the dashboard's brand surfaces — NOT the iOS-blue `--color-accent`.
import { computed } from 'vue'
import Button from '@/components/Button.vue'
import type { DiffPreset } from '@/lib/diff'
import { DIFF_PRESETS } from '@/lib/diff'

const props = defineProps<{
  pickerValue: string
  activePreset: DiffPreset | null
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'update:pickerValue', value: string): void
  (e: 'update:activePreset', value: DiffPreset | null): void
  (e: 'preset', value: DiffPreset): void
  (e: 'load'): void
}>()

const isCustom = computed(() => props.activePreset === null)

function onPickerInput(evt: Event) {
  const target = evt.target as HTMLInputElement
  emit('update:pickerValue', target.value)
  // Manually edited → not any preset anymore.
  emit('update:activePreset', null)
}

function onPresetClick(preset: DiffPreset) {
  emit('update:activePreset', preset)
  emit('preset', preset)
}
</script>

<template>
  <section
    class="px-4 md:px-6 py-4 border-b border-border-subtle bg-surface"
    aria-labelledby="diff-controls-heading"
    data-testid="diff-controls"
  >
    <div class="max-w-[1200px]">
      <h2
        id="diff-controls-heading"
        class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-3"
      >
        Összehasonlítás
      </h2>

      <div class="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <!-- Baseline + current endpoints -->
        <div class="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label
              for="diff-since"
              class="block text-[11px] font-mono uppercase tracking-wider text-text-muted mb-1"
            >
              Korábbi állapot
            </label>
            <input
              id="diff-since"
              :value="pickerValue"
              type="datetime-local"
              lang="hu-HU"
              class="h-9 w-full px-3 rounded-md bg-canvas-2 border border-border-default font-mono text-[13px] text-text-primary focus:border-nct-soft focus:outline-none focus:ring-2 focus:ring-nct-soft/30 transition-colors duration-150"
              :aria-describedby="isCustom ? 'diff-custom-hint' : undefined"
              data-testid="since-input"
              @input="onPickerInput"
            />
            <p
              v-if="isCustom"
              id="diff-custom-hint"
              class="mt-1 text-[11px] text-text-muted"
            >
              Egyéni időpont — a preset nincs kiválasztva.
            </p>
          </div>
          <div>
            <span
              class="block text-[11px] font-mono uppercase tracking-wider text-text-muted mb-1"
            >
              Jelenlegi állapot
            </span>
            <div
              class="h-9 px-3 inline-flex items-center rounded-md bg-canvas-2 border border-border-default text-[13px] text-text-secondary font-mono"
              data-testid="now-pill"
            >
              Most
            </div>
          </div>
        </div>

        <!-- Primary action -->
        <div class="flex items-end justify-end">
          <Button
            variant="primary"
            size="md"
            class="!bg-nct-500 hover:!bg-nct-600 focus-visible:!ring-nct-soft/50 text-text-inverse w-full sm:w-auto"
            :loading="loading"
            :disabled="loading"
            data-testid="load-diff"
            @click="emit('load')"
          >
            Diff betöltése
          </Button>
        </div>
      </div>

      <!-- Preset chips -->
      <div
        class="mt-4 flex items-center gap-2 overflow-x-auto -mx-1 px-1 pb-1"
        role="group"
        aria-label="Gyors időablakok"
        data-testid="diff-presets"
      >
        <span class="text-[11px] text-text-muted shrink-0 pr-1">Gyors:</span>
        <Button
          v-for="preset in DIFF_PRESETS"
          :key="preset.value"
          variant="secondary"
          size="sm"
          :aria-pressed="activePreset === preset.value"
          :class="[
            'shrink-0',
            activePreset === preset.value
              ? '!bg-nct-500/15 !border-nct-soft !text-text-primary'
              : '',
          ]"
          :data-testid="`preset-${preset.value}`"
          @click="onPresetClick(preset.value)"
        >
          {{ preset.label }}
        </Button>
      </div>
    </div>
  </section>
</template>
