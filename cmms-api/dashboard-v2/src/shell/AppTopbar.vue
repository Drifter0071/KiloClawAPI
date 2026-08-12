<script setup lang="ts">
import { ref } from 'vue'
import AppNav from './AppNav.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import OperatorMenu from './OperatorMenu.vue'

const drawerOpen = ref(false)
</script>

<template>
  <header
    class="h-14 shrink-0 sticky top-0 z-30 flex items-center px-4 bg-canvas-2/80 backdrop-blur-md border-b border-border-subtle"
  >
    <!-- Brand (left) -->
    <div class="w-56 flex items-center gap-2 md:w-auto">
      <!-- Logo mark: 20x20, 2px sky-500 stroke, sky-500/20 fill, 1 dot center -->
      <svg
        class="w-5 h-5"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect
          x="3"
          y="3"
          width="14"
          height="14"
          rx="3"
          class="fill-sky-500/20"
          stroke="#0EA5E9"
          stroke-width="2"
        />
        <circle cx="10" cy="10" r="1.25" class="fill-sky-500" />
      </svg>
      <span class="text-sm font-semibold text-text-primary">CMMS API</span>
      <span class="text-[10px] font-mono text-text-muted">v0.6.0</span>
    </div>

    <!-- Primary nav (center) -->
    <div class="flex-1 flex justify-center">
      <AppNav />
    </div>

    <!-- Right cluster -->
    <div class="flex items-center gap-3">
      <ConnectionStatus />
      <OperatorMenu class="hidden md:flex" />
      <!-- Hamburger (mobile only) -->
      <button
        type="button"
        class="md:hidden h-7 w-7 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary flex items-center justify-center"
        :aria-expanded="drawerOpen"
        aria-label="Open navigation"
        @click="drawerOpen = !drawerOpen"
      >
        <span aria-hidden="true">☰</span>
      </button>
    </div>
  </header>

  <!-- Mobile drawer overlay -->
  <div
    v-if="drawerOpen"
    class="fixed inset-0 z-40 md:hidden"
    role="dialog"
    aria-modal="true"
    aria-label="Navigation"
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/60"
      aria-label="Close navigation"
      @click="drawerOpen = false"
    />
    <div
      class="absolute top-0 right-0 h-full w-72 bg-canvas-2 border-l border-border-subtle shadow-lg shadow-black/40 p-4 flex flex-col gap-4"
    >
      <div class="flex items-center justify-between">
        <span class="text-sm font-semibold text-text-primary">Menu</span>
        <button
          type="button"
          class="h-7 w-7 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary flex items-center justify-center"
          aria-label="Close"
          @click="drawerOpen = false"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <nav class="flex flex-col gap-1">
        <RouterLink
          to="/ask"
          class="px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface"
          @click="drawerOpen = false"
          >Ask</RouterLink
        >
        <RouterLink
          to="/stream"
          class="px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface"
          @click="drawerOpen = false"
          >Stream</RouterLink
        >
        <RouterLink
          to="/map"
          class="px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface"
          @click="drawerOpen = false"
          >Map</RouterLink
        >
        <RouterLink
          to="/diff"
          class="px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface"
          @click="drawerOpen = false"
          >Diff</RouterLink
        >
        <RouterLink
          to="/tokens"
          class="px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface"
          @click="drawerOpen = false"
          >Tokens</RouterLink
        >
      </nav>

      <div class="mt-auto">
        <div class="px-3 py-1.5 text-xs text-text-muted">operator</div>
        <div class="h-px bg-border-subtle my-1" aria-hidden="true"></div>
        <form method="POST" action="/dashboard/logout">
          <button
            type="submit"
            class="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface rounded-md"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
