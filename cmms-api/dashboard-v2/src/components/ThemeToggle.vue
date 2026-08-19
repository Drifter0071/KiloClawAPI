<script setup lang="ts">
// src/components/ThemeToggle.vue
//
// Light/dark theme switcher. Two SVG icons (sun + moon) swap based
// on the current theme. Click = toggle. Used in the topbar, on the
// login page, and inside the admin menu.

import { computed } from 'vue'
import { useTheme } from '@/composables/useTheme'

const { theme, toggle } = useTheme()

const isDark = computed(() => theme.value === 'dark')
const ariaLabel = computed(() => (isDark.value ? 'Világos mód' : 'Sötét mód'))
</script>

<template>
  <button
    type="button"
    :aria-label="ariaLabel"
    :title="ariaLabel"
    :aria-pressed="isDark"
    class="inline-flex items-center justify-center w-8 h-8 rounded-md
           text-text-secondary hover:text-text-primary
           hover:bg-surface-2 transition-colors duration-150
           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
    data-testid="theme-toggle"
    @click="toggle"
  >
    <!-- Sun (shown in dark mode → clicking switches to light) -->
    <svg
      v-if="isDark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      class="w-4 h-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.93 19.07 1.41-1.41" />
      <path d="m17.66 6.34 1.41-1.41" />
    </svg>
    <!-- Moon (shown in light mode → clicking switches to dark) -->
    <svg
      v-else
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      class="w-4 h-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  </button>
</template>
