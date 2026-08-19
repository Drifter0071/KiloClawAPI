<script setup lang="ts" generic="T extends string">
import { computed } from 'vue'

type Option = { value: T; label: string }

const props = defineProps<{
  modelValue: T
  options: Option[]
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void
}>()

function isActive(value: T): boolean {
  return value === props.modelValue
}

function selectOption(value: T) {
  if (value !== props.modelValue) {
    emit('update:modelValue', value)
  }
}

const activeIndex = computed(() =>
  props.options.findIndex((o) => o.value === props.modelValue),
)

function onKeydown(evt: KeyboardEvent, index: number) {
  if (evt.key !== 'ArrowRight' && evt.key !== 'ArrowLeft') return
  evt.preventDefault()
  const dir = evt.key === 'ArrowRight' ? 1 : -1
  const next = (index + dir + props.options.length) % props.options.length
  const target = props.options[next]
  if (target) selectOption(target.value)
}
</script>

<template>
  <div
    class="bg-surface rounded-full p-1 inline-flex gap-1 border border-border-subtle"
    role="tablist"
    :aria-label="ariaLabel"
  >
    <button
      v-for="(opt, idx) in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="isActive(opt.value)"
      :tabindex="idx === activeIndex ? 0 : -1"
      :class="[
        'h-7 px-3 rounded-full text-sm font-medium',
        'transition-colors duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        isActive(opt.value)
          ? 'bg-surface-2 text-text-primary'
          : 'text-text-secondary hover:text-text-primary',
      ]"
      @click="selectOption(opt.value)"
      @keydown="onKeydown($event, idx)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
