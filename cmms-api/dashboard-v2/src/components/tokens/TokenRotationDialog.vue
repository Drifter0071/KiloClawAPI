<script setup lang="ts">
// src/components/tokens/TokenRotationDialog.vue
//
// Phase 5.5 — informational rotation dialog. Server returns 501
// today, so we show the manual-instructions note verbatim and offer
// a Copy button. We deliberately do NOT call the rotate API.

import Modal from '@/components/Modal.vue'
import Button from '@/components/Button.vue'

/** Verbatim 501 note from POST /dashboard/api/tokens/rotate. */
const ROTATE_INSTRUCTIONS =
  'update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts'

defineProps<{
  open: boolean
  copied: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'copy'): void
}>()

function close() {
  emit('update:open', false)
}
</script>

<template>
  <Modal :open="open" title="Token rotáció részletei" @update:open="close">
    <p data-testid="rotate-info" class="text-sm text-text-secondary">
      A szerveroldali rotáció jelenleg nincs bekötve. A read token a
      szerver környezeti változójában (<code class="font-mono text-text-primary">CMMS_API_TOKEN_READ</code>)
      él, ezért manuális beavatkozás szükséges:
    </p>

    <pre
      data-testid="rotate-note"
      class="mt-3 bg-canvas-2 border border-border-subtle rounded-md p-3
             font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text-primary"
    >{{ ROTATE_INSTRUCTIONS }}</pre>

    <p class="mt-3 text-xs text-text-muted">
      A rotáció minden aktív klienst érinthet — a meglévő read token
      érvénytelenné válhat, és az érintett integrációknak új
      hitelesítésre lehet szükségük.
    </p>

    <div class="mt-4 flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        data-testid="copy-instructions-btn"
        @click="emit('copy')"
      >
        {{ copied ? 'Másolva ✓' : 'Utasítások másolása' }}
      </Button>
    </div>

    <template #footer>
      <Button variant="ghost" data-testid="modal-close-btn" @click="close">
        Bezárás
      </Button>
    </template>
  </Modal>
</template>
