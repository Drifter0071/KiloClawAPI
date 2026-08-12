<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
  }>(),
  {
    title: undefined,
  },
)

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const panelClass = computed(() => [
  'fixed top-0 right-0 h-full w-96 max-w-[90vw]',
  'bg-canvas-2 border-l border-border-default shadow-lg shadow-black/40',
  'z-50 transform transition-transform duration-150',
  props.open ? 'translate-x-0' : 'translate-x-full',
])

function close() {
  emit('update:open', false)
}

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Escape') {
    evt.stopPropagation()
    close()
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) {
      document.addEventListener('keydown', onKeydown)
    } else {
      document.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 bg-black/60 transition-opacity duration-150"
      aria-hidden="true"
      data-testid="drawer-backdrop"
      @click="close"
    />
    <aside
      v-if="open"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      :class="panelClass"
      data-testid="drawer-panel"
    >
      <div
        v-if="title || $slots.header"
        class="text-lg font-semibold text-text-primary px-6 pt-6 pb-4 border-b border-border-subtle"
      >
        <slot name="header">{{ title }}</slot>
      </div>
      <div class="p-6 text-sm text-text-secondary">
        <slot />
      </div>
      <div
        v-if="$slots.footer"
        class="px-6 pb-6 pt-2 flex items-center justify-end gap-2"
      >
        <slot name="footer" />
      </div>
    </aside>
  </Teleport>
</template>
