<script setup lang="ts">
const links = [
  { name: 'ask', label: 'Ask', path: '/ask' },
  { name: 'stream', label: 'Stream', path: '/stream' },
  { name: 'map', label: 'Térkép', path: '/map' },
  { name: 'diff', label: 'Diff', path: '/diff' },
  { name: 'tokens', label: 'Tokenek', path: '/tokens' },
] as const
</script>

<template>
  <nav class="bg-surface rounded-full p-1 gap-1 hidden md:flex" aria-label="Fő navigáció">
    <RouterLink
      v-for="link in links"
      :key="link.name"
      :to="link.path"
      custom
      v-slot="{ navigate, isActive }"
    >
      <button
        type="button"
        class="px-3 py-1.5 text-sm rounded-full flex items-center gap-1.5 transition-colors duration-150"
        :class="
          isActive
            ? 'bg-surface-2 text-text-primary'
            : 'text-text-secondary hover:text-text-primary'
        "
        :aria-current="isActive ? 'page' : undefined"
        @click="navigate"
      >
        <span
          v-if="isActive"
          aria-hidden="true"
          class="inline-block w-1.5 h-1.5 rounded-full bg-sky-500"
        ></span>
        <span>{{ link.label }}</span>
      </button>
    </RouterLink>
  </nav>
</template>
