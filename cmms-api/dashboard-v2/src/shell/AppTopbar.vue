<script setup lang="ts">
// src/shell/AppTopbar.vue
//
// HIG-flavoured top bar (Phase 7).
//
// One anchored 52px row at the top of the viewport:
//   [logo + name] ........ [nav tabs (centered on md+, hidden on mobile)] ........ [connection + operator]
//
// On mobile (< md) the nav tabs move to the bottom tab bar (BottomTabs.vue)
// — leaving only the logo, connection status, and operator menu up here.

import AppNav from './AppNav.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import OperatorMenu from './OperatorMenu.vue'
</script>

<template>
  <header
    class="h-13 shrink-0 sticky top-0 z-30 flex items-center px-3 md:px-5 bg-canvas-2/90 backdrop-blur-xl border-b border-border-subtle shadow-topbar"
    data-testid="app-topbar"
  >
    <!-- Brand (left) -->
    <div class="flex items-center gap-2 shrink-0">
      <span
        class="w-6 h-6 rounded-md bg-accent/15 border border-accent/40 flex items-center justify-center"
        aria-hidden="true"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-accent" />
      </span>
      <span class="text-[13px] font-semibold tracking-tight text-text-primary">CMMS API</span>
      <span class="hidden sm:inline text-[10px] font-mono text-text-muted">v0.6.0</span>
    </div>

    <!-- Primary nav (centered, md+) — the iOS pattern: tabs live in the
         chrome, not as floating pills in the canvas. -->
    <div class="flex-1 flex justify-center min-w-0 ml-4 md:ml-6">
      <AppNav />
    </div>

    <!-- Right cluster -->
    <div class="flex items-center gap-2 shrink-0">
      <ConnectionStatus />
      <OperatorMenu />
    </div>
  </header>
</template>
