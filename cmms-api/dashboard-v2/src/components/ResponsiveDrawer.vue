<script setup lang="ts">
// src/components/ResponsiveDrawer.vue
//
// Slide-in drawer for the mobile conversation rail. Pinned to the
// viewport edge (left or right) on small screens, full-width sheet
// under 480px.
//
// UX:
//   - Teleported to <body> so the panel sits above any stacking
//     context. The shell's main column has overflow:hidden which
//     would otherwise clip the scrim.
//   - Closes on scrim click, on Escape, and on the v-model:open
//     toggle (parent controls that).
//   - Locks body scroll while open — without this, scrolling the
//     page underneath the drawer drags it along.
//
// The desktop rail is rendered in the AppShell's <aside>, not via
// this component, so the desktop layout stays SSR-safe + accessible
// without a portal.

import { onBeforeUnmount, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** Which edge the drawer slides in from. */
    side?: 'left' | 'right'
    /** Extra width classes (e.g. "md:w-[300px]" — desktop preview).
     *  On mobile the drawer fills almost the whole viewport. */
    widthClass?: string
    /** ARIA label for the dialog wrapper. */
    ariaLabel?: string
  }>(),
  { side: 'left', widthClass: '', ariaLabel: 'Drawer' },
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
}>()

function close(): void {
  emit('update:open', false)
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    document.body.style.overflow = ''
  })
}

// Body scroll lock while open. Watch the prop rather than
// onMounted so the lock applies on every open, not just the first.
let prevOverflow = ''
watch(
  () => props.open,
  (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) {
      prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = prevOverflow
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex"
      :class="side === 'right' ? 'justify-end' : 'justify-start'"
      role="dialog"
      aria-modal="true"
      :aria-label="ariaLabel"
      data-testid="responsive-drawer"
    >
      <!-- Scrim. Stop propagation so clicks here don't bubble into
           the panel content. -->
      <div
        class="absolute inset-0 bg-black/40 backdrop-blur-sm"
        data-testid="responsive-drawer-scrim"
        @click="close"
      />

      <!-- Panel. The widthClass is applied at the sm+ breakpoint
           where the drawer is constrained; below sm it fills the
           viewport (the existing flex justify-* does that). -->
      <div
        class="relative h-full w-full sm:w-[320px] md:w-[360px]
               bg-shell-rail text-shell-rail-text shadow-lg
               flex flex-col overflow-hidden"
        :class="widthClass"
        data-testid="responsive-drawer-panel"
        @click.stop
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
