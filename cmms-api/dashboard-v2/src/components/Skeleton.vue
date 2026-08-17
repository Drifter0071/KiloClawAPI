<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Tailwind height utility (e.g. `'h-4'`, `'h-6'`). Defaults to `h-4`. */
    h?: string
    /** Tailwind width utility (e.g. `'w-32'`, `'w-full'`). Defaults to `w-full`. */
    w?: string
  }>(),
  {
    h: 'h-4',
    w: 'w-full',
  },
)

const classes = computed(() => [
  'rounded-md',
  'bg-surface-2',
  'animate-shimmer',
  props.h,
  props.w,
])
</script>

<template>
  <div
    :class="classes"
    data-testid="skeleton"
    aria-hidden="true"
  />
</template>
