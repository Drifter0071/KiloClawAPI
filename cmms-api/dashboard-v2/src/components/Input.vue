<script setup lang="ts">
import { computed, useAttrs, useSlots } from 'vue'

type Size = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    modelValue: string | number
    placeholder?: string
    type?: string
    monospace?: boolean
    size?: Size
    ariaLabel?: string
    disabled?: boolean
  }>(),
  {
    placeholder: undefined,
    type: 'text',
    monospace: false,
    size: 'md',
    ariaLabel: undefined,
    disabled: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number): void
}>()

const attrs = useAttrs()
const slots = useSlots()

const sizeClasses: Record<Size, string> = {
  sm: 'h-8 text-xs',
  md: 'h-9 text-sm',
  lg: 'h-10 text-base',
}

const inputClasses = computed(() => [
  'w-full',
  'px-3',
  'rounded-md',
  'bg-surface',
  'border border-border-default',
  'text-text-primary',
  'placeholder:text-text-muted',
  'transition-colors duration-150',
  'focus:outline-none',
  'focus:border-accent',
  'focus:ring-2 focus:ring-accent/30',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  sizeClasses[props.size],
  props.monospace ? 'font-mono text-sm' : '',
])

const hasLeading = computed(() => !!slots.leading)
const hasTrailing = computed(() => !!slots.trailing)

function onInput(evt: Event) {
  const target = evt.target as HTMLInputElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <div class="relative w-full">
    <div
      v-if="hasLeading"
      class="absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none flex items-center"
    >
      <slot name="leading" />
    </div>
    <input
      v-bind="attrs"
      :value="modelValue"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :class="[inputClasses, hasLeading ? 'pl-8' : '', hasTrailing ? 'pr-8' : '']"
      @input="onInput"
    />
    <div
      v-if="hasTrailing"
      class="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none flex items-center"
    >
      <slot name="trailing" />
    </div>
  </div>
</template>
