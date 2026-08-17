<script setup lang="ts">
// src/components/Drawer.vue
//
// Side sheet / bottom sheet that overlays the page when `open` is true.
// The previous version had no visible close button — on mobile the user
// had to tap the dark backdrop to dismiss, which was non-obvious. Now:
//
//   - Always renders an X close button in the top-right of the header
//   - On mobile (< md breakpoint) the drawer becomes a bottom sheet
//     anchored to the bottom edge with a drag handle
//   - The backdrop is still tappable as a secondary dismiss action
//   - Escape key still works (desktop)
//
// Usage:
//   <Drawer :open="isOpen" title="Géptípus" @update:open="isOpen = false">
//     <template #header>Optional custom header content</template>
//     ...main content...
//     <template #footer>...</template>
//   </Drawer>
//
// The component teleports into document.body so the fixed positioning
// is always relative to the viewport, not the calling component.

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

/**
 * Panel class. On desktop (≥ md) it's a right-side sheet 24rem wide.
 * On mobile it's a bottom sheet pinned to the bottom edge, full width
 * with a max height of 85vh. The transition is a slide-in from the
 * respective edge; on mobile it slides up from the bottom.
 */
const panelClass = computed(() => [
  // Base
  'fixed z-50 bg-canvas-2 shadow-2xl shadow-black/60',
  'flex flex-col',
  'transform transition-transform duration-200 ease-out',
  // Desktop: right-side sheet
  'md:top-0 md:right-0 md:h-full md:w-96 md:max-w-[90vw]',
  'md:border-l md:border-border-default',
  props.open ? 'md:translate-x-0' : 'md:translate-x-full',
  // Mobile: bottom sheet
  'max-md:bottom-0 max-md:left-0 max-md:right-0',
  'max-md:max-h-[85vh] max-md:rounded-t-2xl',
  'max-md:border-t max-md:border-border-default',
  props.open ? 'max-md:translate-y-0' : 'max-md:translate-y-full',
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
      <!-- Mobile drag handle — purely decorative on a non-draggable
           sheet, but the iOS HIG puts a grip here so the user knows
           "this thing can be dismissed by pulling down". -->
      <div
        class="md:hidden pt-2 pb-1 flex justify-center shrink-0"
        aria-hidden="true"
      >
        <span class="block w-10 h-1 rounded-full bg-border-strong" />
      </div>

      <header
        v-if="title || $slots.header"
        class="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border-subtle shrink-0"
      >
        <div class="min-w-0 flex-1">
          <slot name="header">
            <h2 class="text-md font-semibold text-text-primary leading-tight truncate">
              {{ title }}
            </h2>
          </slot>
        </div>
        <button
          type="button"
          class="shrink-0 -mr-2 -mt-1 w-9 h-9 rounded-full
                 flex items-center justify-center
                 text-text-muted hover:text-text-primary
                 hover:bg-surface-2
                 transition-colors duration-150
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Bezárás"
          data-testid="drawer-close"
          @click="close"
        >
          <svg
            class="w-5 h-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <!-- If there's no title and no header slot, still need a
           standalone close button in the corner. -->
      <button
        v-if="!title && !$slots.header"
        type="button"
        class="absolute top-3 right-3 z-10 w-9 h-9 rounded-full
               flex items-center justify-center
               text-text-muted hover:text-text-primary
               hover:bg-surface-2
               transition-colors duration-150
               focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label="Bezárás"
        data-testid="drawer-close"
        @click="close"
      >
        <svg
          class="w-5 h-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div class="p-6 text-sm text-text-secondary flex-1 overflow-y-auto">
        <slot />
      </div>
      <div
        v-if="$slots.footer"
        class="px-6 pb-6 pt-2 flex items-center justify-end gap-2 border-t border-border-subtle shrink-0"
      >
        <slot name="footer" />
      </div>
    </aside>
  </Teleport>
</template>
