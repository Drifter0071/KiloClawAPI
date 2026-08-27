<script setup lang="ts">
// src/components/AskThreadBar.vue
//
// Thread switcher for the Ask page composer (used in both the empty-state
// hero and the sticky composer):
//   - pill: current thread — titled by its FIRST user message (or the
//     customer label fallback) — plus a one-click "+" new-chat button
//   - popover: "Új beszélgetés" button, the thread list (title, customer
//     · message count · relative time), and "Törlés" (clears the ACTIVE
//     thread's history)
//
// Naming (user decision 2026-08-13): chat names come from the FIRST
// message in the chat, not the raw customer key. Near-identical titles
// (e.g. the router's "PLASMA-TECH SYSTEMS KFT.-" trailing-hyphen quirk)
// are normalized in the store and disambiguated here by appending the
// customer label / date, so the menu never shows duplicate names.
//
// All state lives in the ask Pinia store; this component is pure UI.

import { computed, ref } from 'vue'
import { useAskStore, threadLabel } from '@/stores/ask'

const store = useAskStore()
const menuOpen = ref(false)

function pick(key: string) {
  store.switchThread(key)
  menuOpen.value = false
}

function newChat() {
  store.startNewChat()
  menuOpen.value = false
}

function clearActive() {
  store.clearThread()
  menuOpen.value = false
}

/** Thread list for the menu, with deduped display titles: the second and
 *  later threads sharing a title get the customer label (or the date)
 *  appended so no two rows read identically. */
const displayList = computed(() => {
  const seen = new Map<string, number>()
  return store.index.map((t) => {
    const base = t.title || t.label
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    let title = base
    if (n > 1) {
      const keyLabel = threadLabel(t.key)
      title =
        keyLabel === base || keyLabel === t.label
          ? `${base} · ${fmtShortDate(t.updated)}`
          : `${base} · ${keyLabel}`
    }
    return { key: t.key, title, sub: threadLabel(t.key), count: t.count, updated: t.updated }
  })
})

function fmtShortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

/** Relative time for the sub-line: "most" / "5p" / "2ó" / short date. */
function fmtRel(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'most'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}p`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}ó`
  return fmtShortDate(ts)
}
</script>

<template>
  <div class="flex items-center gap-2" data-testid="ask-thread-bar">
    <!-- Thread switcher pill -->
    <div class="relative">
      <button
        type="button"
        class="flex items-center gap-2 h-8 px-2.5 rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :aria-expanded="menuOpen"
        aria-haspopup="true"
        data-testid="thread-switcher"
        @click="menuOpen = !menuOpen"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
        <span class="text-xs font-medium truncate max-w-[180px]">{{ store.activeTitle }}</span>
        <svg
          class="w-3 h-3 text-text-muted shrink-0"
          viewBox="0 0 12 12"
          fill="none"
          :class="menuOpen ? 'rotate-180' : ''"
          aria-hidden="true"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <div v-if="menuOpen" class="fixed inset-0 z-40" data-testid="thread-menu-backdrop" @click="menuOpen = false" />
      <div
        v-if="menuOpen"
        class="absolute bottom-full left-0 mb-2 z-50 w-80 rounded-xl bg-surface border border-border-subtle shadow-xl shadow-black/20 overflow-hidden"
        data-testid="thread-menu"
      >
        <!-- New chat -->
        <div class="p-2 border-b border-border-subtle/60">
          <button
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-accent/10 text-accent hover:bg-accent/15 transition-colors duration-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            data-testid="thread-new-chat"
            @click="newChat"
          >
            <svg class="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            <span class="text-[13px] font-medium">Új beszélgetés</span>
          </button>
        </div>

        <div class="px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Beszélgetések
        </div>
        <div class="max-h-56 overflow-y-auto py-1">
          <button
            v-for="t in displayList"
            :key="t.key"
            type="button"
            class="w-full flex flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2 transition-colors duration-100 border-l-2"
            :class="t.key === store.threadKey ? 'bg-surface-2 border-l-accent' : 'border-l-transparent'"
            :data-testid="`thread-option-${t.key}`"
            @click="pick(t.key)"
          >
            <span class="text-[13px] font-medium text-text-primary truncate leading-snug">{{ t.title }}</span>
            <span class="text-[10px] text-text-muted tabular-nums truncate">{{ t.sub }} · {{ t.count }} üzenet · {{ fmtRel(t.updated) }}</span>
          </button>
          <div
            v-if="displayList.length === 0"
            class="px-3 py-4 text-center text-xs text-text-muted"
            data-testid="thread-menu-empty"
          >
            Még nincs beszélgetés — kérdezz valamit!
          </div>
        </div>

        <div class="border-t border-border-subtle/60 py-1">
          <button
            type="button"
            class="w-full px-3 py-2 text-left text-[13px] text-danger hover:bg-danger/10 transition-colors duration-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            data-testid="thread-clear"
            @click="clearActive"
          >
            Törlés
          </button>
        </div>
      </div>
    </div>

    <!-- One-click new chat -->
    <button
      type="button"
      class="h-8 w-8 shrink-0 rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-label="Új beszélgetés"
      title="Új beszélgetés"
      data-testid="thread-new-chat-btn"
      @click="newChat"
    >
      <svg class="w-4 h-4 mx-auto" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
// src/components/AskThreadBar.vue
//
// Thread switcher for the Ask page composer (used in both the empty-state
// hero and the sticky composer):
//   - pill: current thread — titled by its FIRST user message (or the
//     customer label fallback) — plus a one-click "+" new-chat button
//   - popover: "Új beszélgetés" button, the thread list (title, customer
//     · message count · relative time), and "Törlés" (clears the ACTIVE
//     thread's history)
//
// Naming (user decision 2026-08-13): chat names come from the FIRST
// message in the chat, not the raw customer key. Near-identical titles
// (e.g. the router's "PLASMA-TECH SYSTEMS KFT.-" trailing-hyphen quirk)
// are normalized in the store and disambiguated here by appending the
// customer label / date, so the menu never shows duplicate names.
//
// All state lives in the ask Pinia store; this component is pure UI.

import { computed, ref } from 'vue'
import { useAskStore, threadLabel } from '@/stores/ask'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const store = useAskStore()
const menuOpen = ref(false)

function pick(key: string) {
  store.switchThread(key)
  menuOpen.value = false
}

function newChat() {
  store.startNewChat()
  menuOpen.value = false
}

// ---------------------------------------------------------------------------
// Delete confirmation — never delete without explicit user confirmation.
// ---------------------------------------------------------------------------

const pendingConfirm = ref(false)

function activeThreadTitle(): string {
  const t = store.index.find((x) => x.key === store.threadKey)
  return t?.title || threadLabel(store.threadKey) || 'Új beszélgetés'
}

function clearActive() {
  menuOpen.value = false
  pendingConfirm.value = true
}

function confirmClear() {
  store.clearThread()
  pendingConfirm.value = false
}

function cancelClear() {
  pendingConfirm.value = false
}

/** Thread list for the menu, with deduped display titles: the second and
 *  later threads sharing a title get the customer label (or the date)
 *  appended so no two rows read identically. */
const displayList = computed(() => {
  const seen = new Map<string, number>()
  return store.index.map((t) => {
    const base = t.title || t.label
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    let title = base
    if (n > 1) {
      const keyLabel = threadLabel(t.key)
      title =
        keyLabel === base || keyLabel === t.label
          ? `${base} · ${fmtShortDate(t.updated)}`
          : `${base} · ${keyLabel}`
    }
    return { key: t.key, title, sub: threadLabel(t.key), count: t.count, updated: t.updated }
  })
})

function fmtShortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

/** Relative time for the sub-line: "most" / "5p" / "2ó" / short date. */
function fmtRel(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'most'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}p`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}ó`
  return fmtShortDate(ts)
}
</script>

<template>
  <div class="flex items-center gap-1.5" data-testid="ask-thread-bar">
    <!-- Thread switcher pill -->
    <div class="relative">
      <button
        type="button"
        class="flex items-center gap-1.5 h-7 px-2 rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :aria-expanded="menuOpen"
        aria-haspopup="true"
        data-testid="thread-switcher"
        @click="menuOpen = !menuOpen"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
        <span class="text-[11px] font-medium truncate max-w-[140px]">{{ store.activeTitle }}</span>
        <svg
          class="w-3 h-3 text-text-muted shrink-0"
          viewBox="0 0 12 12"
          fill="none"
          :class="menuOpen ? 'rotate-180' : ''"
          aria-hidden="true"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <div v-if="menuOpen" class="fixed inset-0 z-40" data-testid="thread-menu-backdrop" @click="menuOpen = false" />
      <div
        v-if="menuOpen"
        class="absolute bottom-full left-0 mb-2 z-50 w-80 rounded-xl bg-surface border border-border-subtle shadow-xl shadow-black/20 overflow-hidden"
        data-testid="thread-menu"
      >
        <!-- New chat -->
        <div class="p-2 border-b border-border-subtle/60">
          <button
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-accent/10 text-accent hover:bg-accent/15 transition-colors duration-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            data-testid="thread-new-chat"
            @click="newChat"
          >
            <svg class="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            <span class="text-[13px] font-medium">Új beszélgetés</span>
          </button>
        </div>

        <div class="px-3 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Beszélgetések
        </div>
        <div class="max-h-56 overflow-y-auto py-1">
          <button
            v-for="t in displayList"
            :key="t.key"
            type="button"
            class="w-full flex flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2 transition-colors duration-100 border-l-2"
            :class="t.key === store.threadKey ? 'bg-surface-2 border-l-accent' : 'border-l-transparent'"
            :data-testid="`thread-option-${t.key}`"
            @click="pick(t.key)"
          >
            <span class="text-[13px] font-medium text-text-primary truncate leading-snug">{{ t.title }}</span>
            <span class="text-[10px] text-text-muted tabular-nums truncate">{{ t.sub }} · {{ t.count }} üzenet · {{ fmtRel(t.updated) }}</span>
          </button>
          <div
            v-if="displayList.length === 0"
            class="px-3 py-4 text-center text-xs text-text-muted"
            data-testid="thread-menu-empty"
          >
            Még nincs beszélgetés — kérdezz valamit!
          </div>
        </div>

        <div class="border-t border-border-subtle/60 py-1">
          <button
            type="button"
            class="w-full px-3 py-2 text-left text-[13px] text-danger hover:bg-danger/10 transition-colors duration-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            data-testid="thread-clear"
            @click="clearActive"
          >
            Törlés
          </button>
        </div>
      </div>
    </div>

    <!-- One-click new chat -->
    <button
      type="button"
      class="h-7 w-7 shrink-0 rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-label="Új beszélgetés"
      title="Új beszélgetés"
      data-testid="thread-new-chat-btn"
      @click="newChat"
    >
      <svg class="w-3.5 h-3.5 mx-auto" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <!-- Delete confirmation dialog -->
    <ConfirmDialog
      :open="pendingConfirm"
      title="Beszélgetés törlése?"
      :detail="activeThreadTitle()"
      description="Biztosan törlöd ezt a beszélgetést? Ez a művelet nem vonható vissza."
      confirm-label="Törlés"
      cancel-label="Mégse"
      tone="danger"
      @update:open="(v) => { if (!v) cancelClear() }"
      @confirm="confirmClear"
      @cancel="cancelClear"
    />
  </div>
</template>
