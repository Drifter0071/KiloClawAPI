<script setup lang="ts">
import { computed, h } from 'vue'
import type { Component } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Visual severity: `warning` (amber) or `error` (rose). */
    severity?: 'warning' | 'error'
    /** Required headline. */
    title: string
    /** Optional supporting copy under the title. */
    description?: string
    /** Optional retry handler. When provided, a "Retry" button is shown. */
    retry?: () => void
    /** Optional icon override. Defaults to a severity-appropriate inline SVG. */
    icon?: Component
  }>(),
  {
    severity: 'error',
    description: undefined,
    retry: undefined,
    icon: undefined,
  },
)

// Default inline SVGs — small (24x24 viewBox) and tinted to severity.
const DefaultWarningIcon = () =>
  h(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: 'w-12 h-12',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.75',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'data-testid': 'error-state-default-icon',
    },
    [
      h('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' }),
      h('line', { x1: '12', y1: '9', x2: '12', y2: '13' }),
      h('line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }),
    ],
  )

const DefaultErrorIcon = () =>
  h(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: 'w-12 h-12',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.75',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'data-testid': 'error-state-default-icon',
    },
    [
      h('circle', { cx: '12', cy: '12', r: '10' }),
      h('line', { x1: '15', y1: '9', x2: '9', y2: '15' }),
      h('line', { x1: '9', y1: '9', x2: '15', y2: '15' }),
    ],
  )

const resolvedIcon = computed<Component>(() => {
  if (props.icon) return props.icon
  return props.severity === 'warning' ? DefaultWarningIcon : DefaultErrorIcon
})

const iconClasses = computed(() =>
  props.severity === 'warning' ? 'w-12 h-12 text-warning' : 'w-12 h-12 text-danger',
)

const titleClasses = computed(() =>
  props.severity === 'warning'
    ? 'text-lg font-medium text-warning'
    : 'text-lg font-medium text-danger',
)
</script>

<template>
  <div
    class="h-full flex flex-col items-center justify-center text-center gap-3 p-6 text-text-muted"
    data-testid="error-state"
    :data-severity="severity"
  >
    <component :is="resolvedIcon" :class="iconClasses" />
    <div :class="titleClasses">{{ title }}</div>
    <div
      v-if="description"
      class="text-sm text-text-muted max-w-md"
    >
      {{ description }}
    </div>
    <button
      v-if="retry"
      type="button"
      class="h-9 px-4 rounded-md bg-accent text-text-inverse text-sm font-medium hover:bg-accent-hover active:scale-[0.98] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      data-testid="error-state-retry"
      @click="retry"
    >
      Retry
    </button>
    <div
      v-if="$slots.actions"
      class="flex gap-2 mt-2"
    >
      <slot name="actions" />
    </div>
  </div>
</template>
