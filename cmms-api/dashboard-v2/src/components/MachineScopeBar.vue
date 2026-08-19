<script setup lang="ts">
// src/components/MachineScopeBar.vue
//
// Machine-scoped ask — the picker shown above the composer. The
// operator selects ONE machine ("M26057", "TMV-400", …) and every
// question is then sent with `context: { device }` so the agent
// answers about THAT machine by default (the user's own wording in
// the question still wins).
//
// Layout:
//   - no scope    → a compact "Gép kiválasztása" pill; tapping it
//                   expands a debounced search input with a results
//                   dropdown (ranked by ticket count).
//   - scope set   → a chip with the device name + an × clear button.

import { nextTick, ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'
import { useMachineScope } from '@/composables/useMachineScope'
import { useToast } from '@/composables/useToast'
import type { DeviceSuggestion } from '@/lib/api'

const api = useApi()
const toast = useToast()
const { device, setDevice, clearScope } = useMachineScope()

const open = ref(false)
const q = ref('')
const results = ref<DeviceSuggestion[]>([])
const busy = ref(false)
const searched = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

let debounce: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0

function close(): void {
  open.value = false
  q.value = ''
  results.value = []
  searched.value = false
}

async function search(raw: string): Promise<void> {
  const needle = raw.trim()
  if (needle.length < 2) {
    results.value = []
    searched.value = false
    return
  }
  const seq = ++searchSeq
  busy.value = true
  try {
    const r = await api.devices(needle, 8)
    if (seq !== searchSeq) return // stale response — a newer search won
    results.value = r.devices ?? []
    searched.value = true
  } catch (e) {
    if (seq !== searchSeq) return
    results.value = []
    searched.value = true
    // eslint-disable-next-line no-console
    console.error('[machine-scope] device search failed', e)
    toast.error('A gépkeresés nem sikerült. Próbáld újra.')
  } finally {
    if (seq === searchSeq) busy.value = false
  }
}

watch(q, (v) => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void search(v), 300)
})

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    nextTick(() => inputEl.value?.focus())
  } else {
    close()
  }
}

function pick(d: DeviceSuggestion): void {
  setDevice(d.name)
  close()
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
  if (ev.key === 'Enter' && results.value.length > 0) {
    pick(results.value[0]!)
  }
}
</script>

<template>
  <div class="flex items-center gap-2" data-testid="machine-scope-bar">
    <!-- Scope set → chip + clear -->
    <template v-if="device">
      <div
        class="inline-flex items-center gap-1.5 h-8 px-3 rounded-full
               bg-nct-soft/10 border border-nct-soft/30
               text-[12px] font-medium text-nct-soft"
        data-testid="machine-scope-chip"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4.5 6a3.5 3.5 0 0 1 7 0c0 1.9-.8 3-1.5 4.1-.5.8-.9 1.6-1 2.4h-2c-.1-.8-.5-1.6-1-2.4C5.3 9 4.5 7.9 4.5 6zM8 1.5v1M12 6h1.5M2.5 6H4"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="max-w-[180px] md:max-w-[260px] truncate">{{ device }}</span>
        <button
          type="button"
          class="w-5 h-5 -mr-1 inline-flex items-center justify-center rounded-full
                 text-nct-soft/70 hover:text-nct-soft hover:bg-nct-soft/15
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
          :aria-label="`Gépszűrés törlése (${device})`"
          data-testid="machine-scope-clear"
          @click="clearScope"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </template>

    <!-- No scope → compact picker pill -->
    <div v-else class="relative" data-testid="machine-scope-picker">
      <button
        v-if="!open"
        type="button"
        class="h-8 px-3 rounded-full inline-flex items-center gap-1.5
               bg-shell-rail-elevated border border-shell-rail-border
               text-[12px] text-chat-read-muted hover:text-chat-read-text hover:border-nct-soft/40
               focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/50
               transition-colors duration-150"
        data-testid="machine-scope-toggle"
        @click="toggle"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4.5 6a3.5 3.5 0 0 1 7 0c0 1.9-.8 3-1.5 4.1-.5.8-.9 1.6-1 2.4h-2c-.1-.8-.5-1.6-1-2.4C5.3 9 4.5 7.9 4.5 6zM8 1.5v1M12 6h1.5M2.5 6H4"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>Gép kiválasztása</span>
      </button>

      <div v-else class="relative" data-testid="machine-scope-search">
        <div
          class="flex items-center gap-2 h-9 px-3 rounded-lg
                 bg-shell-rail-elevated border border-shell-rail-border
                 focus-within:border-nct-soft/50 focus-within:ring-2 focus-within:ring-nct-soft/20"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <input
            ref="inputEl"
            v-model="q"
            type="text"
            class="flex-1 min-w-0 bg-transparent border-0 outline-none text-[13px] text-chat-read-text placeholder:text-chat-read-muted focus:ring-0"
            placeholder="Gép keresése (pl. M26057)…"
            aria-label="Gép keresése"
            data-testid="machine-scope-input"
            @keydown="onKeydown"
            @blur="close"
          />
          <span v-if="busy" class="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin text-chat-read-muted" aria-hidden="true" />
        </div>

        <div
          class="absolute left-0 top-full mt-1.5 z-30 w-72 max-h-72 overflow-y-auto
                 bg-shell-rail-elevated border border-shell-rail-border rounded-lg shadow-xl shadow-black/30"
          data-testid="machine-scope-results"
        >
          <div v-if="!busy && searched && results.length === 0" class="px-3 py-2.5 text-[12px] text-chat-read-muted" data-testid="machine-scope-empty">
            Nincs ilyen gép.
          </div>
          <button
            v-for="d in results"
            :key="d.name"
            type="button"
            class="w-full flex items-center justify-between gap-3 px-3 py-2 text-left
                   hover:bg-shell-rail-hover focus:outline-none focus-visible:bg-shell-rail-hover"
            :data-testid="`machine-scope-option-${d.name}`"
            @mousedown.prevent="pick(d)"
          >
            <span class="font-mono text-[12.5px] text-chat-read-text truncate">{{ d.name }}</span>
            <span class="shrink-0 font-mono text-[10.5px] text-chat-read-muted tabular-nums">{{ d.tickets }} jegy</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
