<script setup lang="ts">
import { computed, useAttrs } from 'vue'

type Variant = 'primary' | 'secondary' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    ariaLabel?: string
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    ariaLabel: undefined,
  },
)

defineEmits<{
  (e: 'click', evt: MouseEvent): void
}>()

const attrs = useAttrs()

const variantClasses: Record<Variant, string> = {
  primary: 'bg-accent text-text-inverse hover:bg-accent-hover',
  secondary: 'border border-border-default text-text-primary hover:bg-surface-2',
  ghost: 'text-text-secondary hover:bg-surface-2',
}

const sizeClasses: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3 text-sm',
  lg: 'h-10 px-4 text-base',
}

const classes = computed(() => [
  'inline-flex items-center justify-center gap-2',
  'rounded-md font-medium',
  'transition-colors duration-150',
  'active:scale-[0.98]',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:border-accent',
  'focus:outline-none',
  variantClasses[props.variant],
  sizeClasses[props.size],
])

const isDisabled = computed(() => props.disabled || props.loading)
</script>

<template>
  <button
    v-bind="attrs"
    :type="type"
    :disabled="isDisabled"
    :aria-label="ariaLabel"
    :aria-busy="loading || undefined"
    :class="classes"
    @click="(evt) => !isDisabled && $emit('click', evt)"
  >
    <span
      v-if="loading"
      class="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
      aria-hidden="true"
    />
    <slot v-else />
  </button>
</template>
