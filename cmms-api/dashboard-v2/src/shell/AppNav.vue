<script setup lang="ts">
// src/shell/AppNav.vue
//
// HIG-flavoured nav (Phase 7) + Phase 8 purple rebrand.
//
// A flat tab strip — not a pill. Active tab gets a 1px purple underline
// (nct-soft, the brand lighter purple) and the label colour shifts to
// text-primary; inactive tabs sit at text-secondary. Hidden on mobile
// (BottomTabs handles those).
//
// All 5 routes (Ask, Stream, Térkép, Diff, Tokenek) get a slot here.
// Admin is NOT in this nav — it lives in a separate SPA at
// /dashboard/admin/, accessed via the "Admin panel" item in
// OperatorMenu which does a full window.location navigation. Adding
// the Admin link here would imply the admin panel is part of this
// app, which the user explicitly rejected.

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
        class="relative h-full px-3.5 text-[13px] font-medium tracking-tight flex items-center gap-1.5 transition-colors duration-150 focus:outline-none focus-visible:ring-2 rounded-md"
        :class="
          isExactActive
            ? 'text-text-primary focus-visible:ring-nct-soft/50'
            : isActive
              ? 'text-text-primary focus-visible:ring-nct-soft/50'
              : 'text-text-secondary hover:text-text-primary focus-visible:ring-nct-soft/50'
        "
        :aria-current="isExactActive ? 'page' : undefined"
        :data-testid="`app-nav-${link.name}`"
        @click="navigate"
      >
        <span>{{ link.label }}</span>
        <!-- Active tab: 1px purple underline. Apple-tab pattern. -->
        <span
          v-if="isExactActive"
          aria-hidden="true"
          class="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-nct-soft shadow-[0_0_6px_rgba(124,95,173,0.45)]"
        />
      </button>
    </RouterLink>
  </nav>
</template>
