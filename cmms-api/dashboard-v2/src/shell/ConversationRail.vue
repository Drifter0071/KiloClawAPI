<script setup lang="ts">
// src/shell/ConversationRail.vue
//
// Left navigation rail for the v2 chat shell.
//
// Three regions, top to bottom:
//   1. Brand identity (NCT mark + name + sub-label) + new-chat action
//   2. Scrollable conversation list (loaded from the ask Pinia store)
//   3. Footer: nav links, theme toggle, connection status, operator menu
//
// Used in two modes:
//   - "rail" : embedded in the desktop app shell, always visible
//   - "panel": teleported into a ResponsiveDrawer on mobile
//
// The mode is decided by the parent — this component is purely visual.

import { computed, ref, watch } from 'vue'

// The rail can be embedded in two parents:
//   - desktop app shell (always visible, no close button)
//   - mobile ResponsiveDrawer (opens/closes via AppShell)
// The parent decides what to do with `close-rail`; the rail itself
// doesn't know which mode it's in — it just shows the button on
// small viewports where a close action makes sense.
const emit = defineEmits<{
  (e: 'close-rail'): void
}>()

function requestClose() {
  emit('close-rail')
}
import { useRouter } from 'vue-router'
import { useAskStore, threadLabel, type ThreadInfo } from '@/stores/ask'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import OperatorMenu from './OperatorMenu.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import NctMark from '@/components/NctMark.vue'

const router = useRouter()
const store = useAskStore()

const filter = ref('')

const navItems = [
  { name: 'ask', label: 'Ask', path: '/ask' },
  { name: 'stream', label: 'Stream', path: '/stream' },
  { name: 'map', label: 'Térkép', path: '/map' },
  { name: 'diff', label: 'Diff', path: '/diff' },
  { name: 'tokens', label: 'Tokenek', path: '/tokens' },
] as const

const currentPath = computed(() => router.currentRoute.value.path)

function isActiveNav(path: string): boolean {
  return currentPath.value === path
}

function fmtRel(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'most'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}p`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}ó`
  return new Date(ts).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

const filteredThreads = computed<ThreadInfo[]>(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return store.index
  return store.index.filter((t) => {
    const base = (t.title || t.label || '').toLowerCase()
    const sub = threadLabel(t.key).toLowerCase()
    return base.includes(q) || sub.includes(q)
  })
})

function pickThread(key: string) {
  store.switchThread(key)
  router.push('/ask').catch(() => {})
}

function newChat() {
  store.startNewChat()
  router.push('/ask').catch(() => {})
}

// ---------------------------------------------------------------------------
// Destructive actions — confirm via in-app dialog, not window.confirm
// ---------------------------------------------------------------------------
//
// window.confirm() is unreliable on mobile webviews (often auto-dismissed
// or shown so briefly the user can't see it). The in-app ConfirmDialog
// is a real accessible modal that works on every platform.

type PendingConfirm =
  | { kind: 'clear-active'; title: string; detail: string }
  | { kind: 'delete-thread'; key: string; title: string; detail: string }

const pendingConfirm = ref<PendingConfirm | null>(null)

function activeThreadTitle(): string {
  const t = store.index.find((x) => x.key === store.threadKey)
  return t?.title || threadLabel(store.threadKey) || 'Új beszélgetés'
}

function askClearActive() {
  pendingConfirm.value = {
    kind: 'clear-active',
    title: 'Aktuális beszélgetés törlése',
    detail: activeThreadTitle(),
  }
}

function askDeleteThread(key: string) {
  const t = store.index.find((x) => x.key === key)
  pendingConfirm.value = {
    kind: 'delete-thread',
    key,
    title: 'Beszélgetés törlése',
    detail: t?.title || threadLabel(key) || 'Új beszélgetés',
  }
}

function confirmAction() {
  const p = pendingConfirm.value
  if (!p) return
  if (p.kind === 'clear-active') {
    store.clearThread()
  } else if (p.kind === 'delete-thread') {
    store.removeThread(p.key)
  }
  pendingConfirm.value = null
}

function cancelConfirm() {
  pendingConfirm.value = null
}

function deleteThread(key: string, e: Event) {
  // Prevent the row's own @click (which would switch to the deleted
  // thread) from firing — the dialog should be the only outcome.
  e.stopPropagation()
  e.preventDefault()
  askDeleteThread(key)
}

function clearActive() {
  askClearActive()
}

// Re-render relative timestamps when the index changes (a new message
// lands) so "5p" → "6p" without a page reload.
watch(
  () => store.index.map((t) => t.updated).join(','),
  () => {
    /* triggers a recompute of fmtRel via dependency on store.index */
  },
)
</script>

<template>
  <div
    class="flex flex-col h-full bg-shell-rail text-shell-rail-text"
    data-testid="conversation-rail"
  >
    <!-- Brand + new chat -->
    <div class="px-3 pt-4 pb-3 border-b border-shell-rail-border">
      <div class="flex items-center gap-2 px-1">
        <NctMark :size="26" :glow="false" />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-semibold tracking-tight text-shell-rail-text truncate">
            NCT Szerviz Ai
          </div>
          <div class="text-[10px] font-mono uppercase tracking-wider text-shell-rail-muted">
            v2 · belső karbantartási
          </div>
        </div>
        <button
          type="button"
          class="md:hidden shrink-0 h-8 w-8 inline-flex items-center justify-center
                 rounded-md text-shell-rail-muted
                 hover:text-shell-rail-text hover:bg-shell-rail-hover
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
                 transition-colors duration-150"
          aria-label="Menü bezárása"
          title="Bezárás"
          data-testid="rail-close"
          @click="requestClose"
        >
          <svg
            class="w-4 h-4"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <button
        type="button"
        class="mt-3 w-full flex items-center justify-center gap-2 h-9 px-3 rounded-md
               bg-nct-500 hover:bg-nct-600 text-white text-[13px] font-medium
               transition-colors duration-150
               focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
        aria-label="Új beszélgetés indítása"
        data-testid="rail-new-chat"
        @click="newChat"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <span>Új beszélgetés</span>
      </button>
    </div>

    <!-- Nav (compact) -->
    <nav
      class="px-2 py-2 border-b border-shell-rail-border"
      aria-label="Alkalmazás"
      data-testid="rail-nav"
    >
      <RouterLink
        v-for="item in navItems"
        :key="item.name"
        :to="item.path"
        custom
        v-slot="{ navigate }"
      >
        <button
          type="button"
          class="w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md
                 text-[12.5px] font-medium tracking-tight
                 transition-colors duration-150
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
          :class="
            isActiveNav(item.path)
              ? 'bg-shell-rail-active text-shell-rail-text'
              : 'text-shell-rail-muted hover:text-shell-rail-text hover:bg-shell-rail-hover'
          "
          :data-testid="`rail-nav-${item.name}`"
          @click="navigate"
        >
          <span
            class="w-1 h-1 rounded-full"
            :class="isActiveNav(item.path) ? 'bg-nct-soft' : 'bg-transparent'"
            aria-hidden="true"
          />
          <span>{{ item.label }}</span>
        </button>
      </RouterLink>
    </nav>

    <!-- Conversation list -->
    <div class="flex-1 min-h-0 flex flex-col" data-testid="rail-thread-region">
      <div class="px-3 pt-3 pb-1.5 flex items-center justify-between">
        <span class="text-[10px] font-mono uppercase tracking-wider text-shell-rail-muted">
          Beszélgetések
        </span>
        <span
          v-if="store.index.length > 0"
          class="text-[10px] font-mono tabular-nums text-shell-rail-muted"
          data-testid="rail-thread-count"
        >
          {{ store.index.length }}
        </span>
      </div>
      <div class="px-3 pb-2">
        <div class="relative">
          <input
            v-model="filter"
            type="text"
            placeholder="Keresés…"
            aria-label="Beszélgetések keresése"
            data-testid="rail-thread-filter"
            class="w-full h-8 pl-7 pr-2 rounded-md
                   bg-shell-rail-elevated border border-shell-rail-border
                   text-[12px] text-shell-rail-text placeholder:text-shell-rail-muted
                   focus:outline-none focus:border-nct-500/60 focus:ring-2 focus:ring-nct-500/20
                   transition-colors duration-150"
          />
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-shell-rail-muted"
          >
            <circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        <div
          v-if="filteredThreads.length === 0"
          class="px-3 py-6 text-center text-[12px] text-shell-rail-muted"
          data-testid="rail-thread-empty"
        >
          <template v-if="store.index.length === 0">
            Még nincs beszélgetés.
            <br />
            Kérdezz valamit lent →
          </template>
          <template v-else>Nincs találat.</template>
        </div>
        <ul v-else class="space-y-0.5">
          <li
            v-for="t in filteredThreads"
            :key="t.key"
            class="group/row relative"
          >
            <div
              class="w-full flex flex-col gap-0.5 pl-2.5 pr-7 py-2 rounded-md
                     transition-colors duration-150 relative
                     focus-within:ring-2 focus-within:ring-nct-soft/60"
              :class="
                t.key === store.threadKey
                  ? 'bg-shell-rail-active'
                  : 'hover:bg-shell-rail-hover'
              "
            >
              <button
                type="button"
                class="absolute inset-0 w-full h-full rounded-md text-left
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
                :data-testid="`rail-thread-${t.key}`"
                @click="pickThread(t.key)"
              >
                <span class="sr-only">
                  Beszélgetés megnyitása: {{ t.title || threadLabel(t.key) || 'Új beszélgetés' }}
                </span>
              </button>
              <div class="flex items-center gap-2 min-w-0">
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  :class="
                    t.key === store.threadKey
                      ? 'bg-nct-soft'
                      : 'bg-shell-rail-muted/60 group-hover/row:bg-shell-rail-muted'
                  "
                  aria-hidden="true"
                />
                <span
                  class="text-[12.5px] font-medium tracking-tight truncate min-w-0"
                  :class="
                    t.key === store.threadKey ? 'text-shell-rail-text' : 'text-shell-rail-text/85'
                  "
                >
                  {{ t.title || threadLabel(t.key) || 'Új beszélgetés' }}
                </span>
              </div>
              <div class="flex items-center gap-1.5 pl-3.5 text-[10px] font-mono tabular-nums text-shell-rail-muted">
                <span class="truncate">{{ threadLabel(t.key) }}</span>
                <span aria-hidden="true">·</span>
                <span class="shrink-0">{{ t.count }} üzenet</span>
                <span aria-hidden="true">·</span>
                <span class="shrink-0">{{ fmtRel(t.updated) }}</span>
              </div>
            </div>
            <button
              type="button"
              class="hidden md:flex absolute top-1.5 right-1.5 h-6 w-6 items-center justify-center
                     rounded-md text-shell-rail-muted
                     opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
                     hover:text-danger hover:bg-danger/10
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/50
                     transition-[opacity,color,background-color] duration-150
                     z-[1]"
              :aria-label="`Beszélgetés törlése: ${t.title || threadLabel(t.key) || 'Új beszélgetés'}`"
              :title="`Törlés: ${t.title || threadLabel(t.key) || 'Új beszélgetés'}`"
              :data-testid="`rail-thread-delete-${t.key}`"
              @click="deleteThread(t.key, $event)"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- Footer: connection, theme, operator -->
    <div class="px-3 py-3 border-t border-shell-rail-border space-y-2">
      <div class="flex items-center justify-between gap-2">
        <ConnectionStatus />
        <ThemeToggle />
      </div>
      <div class="flex items-center justify-between">
        <OperatorMenu />
        <button
          v-if="store.index.length > 0"
          type="button"
          class="text-[11px] font-mono text-shell-rail-muted hover:text-danger
                 transition-colors duration-150
                 focus:outline-none focus-visible:underline"
          data-testid="rail-clear-active"
          @click="clearActive"
        >
          Aktuális törlése
        </button>
      </div>
    </div>

    <!-- Destructive-action confirmation (replaces window.confirm,
         which is unreliable on mobile webviews). -->
    <ConfirmDialog
      :open="pendingConfirm !== null"
      :title="pendingConfirm?.title ?? ''"
      :detail="pendingConfirm?.detail"
      :message="
        pendingConfirm?.kind === 'clear-active'
          ? 'Az aktuális beszélgetés üzenetei végleg törlődnek. A művelet nem visszavonható.'
          : 'Ez a beszélgetés végleg törlődik. A művelet nem visszavonható.'
      "
      confirm-label="Törlés"
      tone="danger"
      @update:open="(v) => { if (!v) cancelConfirm() }"
      @confirm="confirmAction"
      @cancel="cancelConfirm"
    />
  </div>
</template>
