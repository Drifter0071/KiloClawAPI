<script setup lang="ts">
// src/shell/BottomTabs.vue
//
// HIG mobile bottom tab bar (Phase 7) + Phase 8 purple rebrand.
//
// iOS tab bar pattern: 5 evenly-spaced icons + labels, fixed to the
// bottom of the viewport, with a translucent background + 1px top
// separator. Hidden on >= md (the top nav takes over). The bar
// respects safe-area-inset-bottom for notched phones.
//
// We keep 5 tabs (matches the desktop nav) so operators don't have to
// context-switch when rotating from phone to desktop. The icons are
// single-path SVGs — no library.
//
// Color: uses the NCT purple brand (nct-500 / nct-soft) directly so
// the active tab reads as part of the page's purple design language
// in BOTH light and dark mode (not the iOS-blue `--color-accent`).

const tabs = [
  {
    name: 'ask',
    label: 'Ask',
    path: '/ask',
    icon: 'M4 5h16v10H7l-3 3V5z',
  },
  {
    name: 'stream',
    label: 'Stream',
    path: '/stream',
    icon: 'M3 12h2l2-6 4 12 4-9 2 6h4',
  },
  {
    name: 'map',
    label: 'Térkép',
    path: '/map',
    icon: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  },
  {
    name: 'diff',
    label: 'Diff',
    path: '/diff',
    icon: 'M12 3v18M5 8h7M5 16h7M12 8h7M12 16h7',
  },
  {
    name: 'tokens',
    label: 'Tokenek',
    path: '/tokens',
    icon: 'M6 4h12v16H6zM10 8h4M10 12h4M10 16h2',
  },
] as const
</script>

<template>
  <nav
    class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-tabbar backdrop-blur-xl border-t border-nct-500/15 shadow-tabbar"
    :style="{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }"
    aria-label="Fő navigáció"
    data-testid="bottom-tabs"
  >
    <ul class="grid grid-cols-5 h-16">
      <li v-for="tab in tabs" :key="tab.name" class="contents">
        <RouterLink
          :to="tab.path"
          custom
          v-slot="{ navigate, isExactActive }"
        >
          <button
            type="button"
            class="relative flex flex-col items-center justify-center gap-1 h-full transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/50 rounded-md"
            :class="isExactActive ? 'text-nct-soft' : 'text-text-muted active:text-text-secondary'"
            :aria-current="isExactActive ? 'page' : undefined"
            :aria-label="tab.label"
            :data-testid="`bottom-tab-${tab.name}`"
            @click="navigate"
          >
            <!-- active top-pill in NCT purple so the active tab reads
                 as part of the brand family, not just a tinted icon -->
            <span
              v-if="isExactActive"
              class="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-b-full bg-nct-soft shadow-[0_0_8px_rgba(124,95,173,0.55)]"
              aria-hidden="true"
            />
            <svg
              class="w-5 h-5 transition-transform duration-200"
              :class="isExactActive ? 'scale-110' : 'scale-100'"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              :stroke-width="isExactActive ? 2.1 : 1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="tab.icon" />
            </svg>
            <span
              class="text-[10px] font-medium tracking-tight"
              :class="isExactActive ? 'text-nct-soft' : ''"
            >{{ tab.label }}</span>
          </button>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>
