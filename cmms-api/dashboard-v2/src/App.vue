<script setup lang="ts">
import AppShell from './shell/AppShell.vue'
// Install the global keyboard-shortcut listener once. The composable is
// idempotent (it short-circuits on second call) so it's safe to call here
// even if a future refactor moves <AppShell> around.
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
useKeyboardShortcuts()
</script>

<template>
  <AppShell />
</template>
