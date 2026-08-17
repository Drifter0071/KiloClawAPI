<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  /** Optional icon component to render above the title (e.g. lucide-vue-next icons). */
  icon?: Component
  /** Required headline. */
  title: string
  /** Optional supporting copy under the title. */
  description?: string
}>()
</script>

<template>
  <div
    class="h-full flex flex-col items-center justify-center text-center gap-3 p-6 text-text-muted"
    data-testid="empty-state"
  >
    <component
      v-if="icon"
      :is="icon"
      class="w-12 h-12 text-text-muted"
      aria-hidden="true"
    />
    <div class="text-lg font-medium text-text-primary">{{ title }}</div>
    <div
      v-if="description"
      class="text-sm text-text-muted max-w-md"
    >
      {{ description }}
    </div>
    <div
      v-if="$slots.actions"
      class="flex gap-2 mt-2"
    >
      <slot name="actions" />
    </div>
  </div>
</template>
