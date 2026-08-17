<script setup lang="ts">
import { computed } from 'vue'

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info'

const props = withDefaults(
  defineProps<{
    label?: string
    variant?: Variant
  }>(),
  {
    label: undefined,
    variant: 'default',
  },
)

const variantClasses: Record<Variant, string> = {
  default: 'bg-surface-2 text-text-secondary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-accent/15 text-accent',
}

const classes = computed(() => [
  'inline-flex h-5 items-center rounded-full px-2',
  'font-mono text-[10px] uppercase tracking-wider',
  variantClasses[props.variant],
])
</script>

<template>
  <span :class="classes">
    <slot>{{ label }}</slot>
  </span>
</template>
