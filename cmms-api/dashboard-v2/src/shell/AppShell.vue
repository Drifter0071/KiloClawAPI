<script setup lang="ts">
import AppTopbar from './AppTopbar.vue'
import GlobalBanner from './GlobalBanner.vue'
</script>

<template>
  <div class="h-screen flex flex-col bg-canvas text-text-primary font-sans">
    <AppTopbar />
    <GlobalBanner />
    <main class="flex-1 overflow-auto">
      <router-view />
    </main>
  </div>
</template>
