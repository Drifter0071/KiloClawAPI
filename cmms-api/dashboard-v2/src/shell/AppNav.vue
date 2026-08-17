<script setup lang="ts">
// src/shell/AppNav.vue
//
// HIG-flavoured nav (Phase 7).
//
// A flat tab strip — not a pill. Active tab gets a 1px accent underline
// and the label colour shifts to text-primary; inactive tabs sit at
// text-secondary. Hidden on mobile (BottomTabs handles those).
//
// All 5 routes (Ask, Stream, Térkép, Diff, Tokenek) get a slot here.
// The mobile bottom tab bar shows the 4 most-used and links to /ask
// from the centre (Ask is the most common entry point).

const links = [
  { name: 'ask', label: 'Ask', path: '/ask' },
  { name: 'stream', label: 'Stream', path: '/stream' },
  { name: 'map', label: 'Térkép', path: '/map' },
  { name: 'diff', label: 'Diff', path: '/diff' },
  { name: 'tokens', label: 'Tokenek', path: '/tokens' },
] as const
</script>

<template>
  <nav
    class="hidden md:flex h-9 items-stretch gap-0"
    aria-label="Fő navigáció"
    data-testid="app-nav"
  >
    <RouterLink
      v-for="link in links"
      :key="link.name"
      :to="link.path"
      custom
      v-slot="{ navigate, isActive, isExactActive }"
    >
      <button
        type="button"
        class="relative h-full px-3.5 text-[13px] font-medium tracking-tight flex items-center gap-1.5 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-md"
        :class="
          isExactActive
            ? 'text-text-primary'
            : isActive
              ? 'text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
        "
        :aria-current="isExactActive ? 'page' : undefined"
        :data-testid="`app-nav-${link.name}`"
        @click="navigate"
      >
        <span>{{ link.label }}</span>
        <!-- Active tab: 1px accent underline. Apple-tab pattern. -->
        <span
          v-if="isExactActive"
          aria-hidden="true"
          class="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-accent"
        />
      </button>
    </RouterLink>
  </nav>
</template>
