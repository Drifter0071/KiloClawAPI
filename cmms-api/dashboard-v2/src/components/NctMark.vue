<script setup lang="ts">
// src/components/NctMark.vue
//
// The dashboard brand mark — a friendly purple wrench mascot (PNG asset in
// /public/brand-mark.png). Replaces the previous inline-SVG "N" glyph so
// the favicon, topbar, conversation rail, and login page all share the
// same friendly mascot.
//
// `size` is in pixels and scales the rendered box. The PNG is square with
// a transparent background so it composites cleanly on any surface.

withDefaults(
  defineProps<{
    size?: number
    /** When true, draw a soft ambient glow halo behind the mark. */
    glow?: boolean
  }>(),
  { size: 32, glow: false },
)
</script>

<template>
  <span
    class="relative inline-flex items-center justify-center shrink-0"
    :style="{ width: size + 'px', height: size + 'px' }"
    aria-hidden="true"
  >
    <span
      v-if="glow"
      class="absolute inset-[-30%] rounded-full bg-nct-glow blur-2xl animate-nct-pulse-glow"
    />
    <img
      :src="'/dashboard/v2/brand-mark.png'"
      :width="size"
      :height="size"
      :alt="''"
      class="relative block select-none"
      draggable="false"
      decoding="async"
    />
  </span>
</template>
