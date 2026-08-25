<script setup lang="ts">
// src/components/PhotoCropStage.vue
//
// Crop-before-OCR stage of the Fotó flow (Pack 1, 2026-08-25,
// brainstorm idea A6). The single biggest OCR lever after engine
// parameters: let the technician frame JUST the text block before we
// read it, so background clutter and machine-body texture never reach
// Tesseract.
//
// Interaction model (workshop-gloves friendly):
//   - A default slightly-inset rect is pre-selected — most shots only
//     need "Szöveg kiolvasása" without any adjustment.
//   - Four big finger handles drag the corners; dragging inside the
//     frame moves it. Rect math lives in lib/cropRect.ts (unit-tested,
//     DOM-free).
//   - "A teljes képet olvasd" skips cropping entirely.
//
// Degradation: if the image hasn't decoded or canvas is unavailable,
// confirm() emits null and the parent runs OCR on the ORIGINAL file —
// cropping must never hard-fail the flow.

import { ref } from 'vue'
import {
  applyCornerDrag,
  clampRect,
  cornerAt,
  defaultCropRect,
  fullRect,
  insideRect,
  moveRect,
  type Corner,
  type CropRect,
} from '@/lib/cropRect'
import { canvasToBlob } from '@/lib/ocrPreprocess'

const props = defineProps<{
  /** Object URL of the captured photo (preview + export source). */
  src: string
}>()

const emit = defineEmits<{
  /** Cropped PNG, or null when cropping was impossible (parent falls
   *  back to the untouched original). */
  (e: 'confirm', blob: Blob | null): void
  (e: 'skip'): void
}>()

/** Export ceiling — same rationale as ocrPreprocess.MAX_SIDE but a
 *  little higher since a tight crop already removed the clutter. */
const MAX_EXPORT_SIDE = 2200

const imgEl = ref<HTMLImageElement | null>(null)
const frameEl = ref<HTMLDivElement | null>(null)
const loaded = ref(false)
const rect = ref<CropRect>(defaultCropRect())
const busy = ref(false)

type Drag =
  | { mode: 'corner'; corner: Corner; start: CropRect }
  | { mode: 'move'; start: CropRect; px: number; py: number }

let drag: Drag | null = null

function normPoint(e: PointerEvent): { x: number; y: number } {
  const el = frameEl.value
  if (!el) return { x: 0, y: 0 }
  const b = el.getBoundingClientRect()
  return {
    x: b.width === 0 ? 0 : (e.clientX - b.left) / b.width,
    y: b.height === 0 ? 0 : (e.clientY - b.top) / b.height,
  }
}

function onHandleDown(e: PointerEvent, corner: Corner): void {
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { mode: 'corner', corner, start: { ...rect.value } }
}

function onFrameDown(e: PointerEvent): void {
  const p = normPoint(e)
  // Handles sit ABOVE the frame in DOM order, so a press here is
  // either inside the rect (move) or outside it (also move-to? no —
  // ignore outside presses; handles are the resize affordance).
  if (!insideRect(rect.value, p.x, p.y)) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { mode: 'move', start: { ...rect.value }, px: p.x, py: p.y }
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return
  const p = normPoint(e)
  if (drag.mode === 'corner') {
    rect.value = applyCornerDrag(drag.start, drag.corner, p.x, p.y)
  } else {
    rect.value = moveRect(drag.start, p.x - drag.px, p.y - drag.py)
  }
}

function onPointerUp(): void {
  drag = null
}

function resetFull(): void {
  rect.value = fullRect()
}

async function confirm(): Promise<void> {
  if (busy.value) return
  const img = imgEl.value
  if (!loaded.value || !img || !img.naturalWidth || !img.naturalHeight) {
    emit('confirm', null)
    return
  }
  busy.value = true
  try {
    const r = clampRect(rect.value)
    const natW = img.naturalWidth
    const natH = img.naturalHeight
    const scale = Math.min(1, MAX_EXPORT_SIDE / Math.max(natW, natH))
    const w = Math.max(1, Math.round(r.w * natW * scale))
    const h = Math.max(1, Math.round(r.h * natH * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas-unavailable')
    ctx.drawImage(
      img,
      r.x * natW,
      r.y * natH,
      r.w * natW,
      r.h * natH,
      0,
      0,
      w,
      h,
    )
    emit('confirm', await canvasToBlob(canvas))
  } catch {
    emit('confirm', null)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-3" data-testid="photo-ask-crop">
    <p class="text-[12.5px] text-text-secondary leading-snug">
      Fogd meg a sarkokat, és jelöld ki a szöveget. Így csak azt olvassuk be.
    </p>

    <!-- Frame + overlay. The shade is a giant box-shadow so the rect
         edges stay crisp without four extra shade divs. -->
    <div
      ref="frameEl"
      class="relative overflow-hidden rounded-lg border border-border-subtle bg-black select-none"
      data-testid="photo-crop-frame"
      style="touch-action: none"
      @pointerdown="onFrameDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img
        ref="imgEl"
        :src="src"
        alt="Lefotózott tábla"
        class="block w-full h-auto pointer-events-none"
        draggable="false"
        @load="loaded = true"
      />
      <div
        class="absolute border-2 border-accent pointer-events-none"
        :style="{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
        }"
      />
      <button
        v-for="c in (['nw', 'ne', 'se', 'sw'] as const)"
        :key="c"
        type="button"
        class="absolute w-8 h-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-white/95 shadow-md active:scale-110 transition-transform"
        :class="[
          c === 'nw' && 'cursor-nwse-resize',
          c === 'ne' && 'cursor-nesw-resize',
          c === 'se' && 'cursor-nwse-resize',
          c === 'sw' && 'cursor-nesw-resize',
        ]"
        :style="{
          left: `${((c === 'nw' || c === 'sw' ? rect.x : rect.x + rect.w)) * 100}%`,
          top: `${((c === 'nw' || c === 'ne' ? rect.y : rect.y + rect.h)) * 100}%`,
        }"
        :data-testid="`photo-crop-handle-${c}`"
        :aria-label="`Sarok ${c.toUpperCase()}`"
        @pointerdown="onHandleDown($event, c)"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>

    <div class="flex gap-2">
      <button
        type="button"
        class="flex-1 h-11 rounded-lg border border-border-subtle bg-surface text-[13px] font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 disabled:opacity-40"
        data-testid="photo-ask-crop-skip"
        @click="resetFull(); emit('skip')"
      >
        A teljes képet olvasd
      </button>
      <button
        type="button"
        class="flex-1 h-11 rounded-lg bg-accent text-text-inverse font-semibold text-[13px] hover:bg-accent-hover active:scale-[0.98] transition-all duration-150 disabled:opacity-40"
        data-testid="photo-ask-crop-confirm"
        :disabled="busy"
        @click="confirm"
      >
        Szöveg kiolvasása
      </button>
    </div>
  </div>
</template>
