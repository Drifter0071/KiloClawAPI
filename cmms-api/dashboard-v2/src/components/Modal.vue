<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

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
      data-testid="modal-backdrop"
      @click="close"
    />
    <div
      v-if="open"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-canvas-2 border border-border-default rounded-lg shadow-lg shadow-black/40 p-6"
      data-testid="modal-panel"
    >
      <div
        v-if="title || $slots.header"
        class="text-lg font-semibold text-text-primary mb-4"
      >
        <slot name="header">{{ title }}</slot>
      </div>
      <div class="text-sm text-text-secondary">
        <slot />
      </div>
      <div
        v-if="$slots.footer"
        class="mt-6 flex items-center justify-end gap-2"
      >
        <slot name="footer" />
      </div>
    </div>
  </Teleport>
</template>
