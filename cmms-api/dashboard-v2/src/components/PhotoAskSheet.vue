<script setup lang="ts">
// src/components/PhotoAskSheet.vue
//
// Phase 8 (2026-08-24), brainstorm idea A7 + B7 — photo-to-ask.
// Bottom sheet (mobile) / centered modal (desktop) that:
//   1. Lets the operator snap a photo of the machine plate OR pick
//      one from the camera roll.
//   2. Runs Tesseract.js in-browser to OCR the image.
//   3. Picks the most likely serial number (M-26057, M17191, …).
//   4. Pre-fills the AskBar with a question scoped to that serial.
//   5. Submits the question on behalf of the user (or returns the
//      serial for the user to type around).
//
// We do NOT send the photo to the server — OCR runs locally. Only
// the extracted serial is forwarded to AskPage. The user can edit
// the pre-filled question before submitting (we surface it in a
// textarea, not as a silent auto-submit).

import { onBeforeUnmount, ref, watch } from 'vue'
import { recognizeSerialFromImage, type OcrResult } from '@/lib/ocrSerial'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void
  (e: 'submit', question: string): void
}>()

const fileInputEl = ref<HTMLInputElement | null>(null)
const previewUrl = ref<string | null>(null)
const busy = ref<boolean>(false)
const errorMsg = ref<string | null>(null)
const result = ref<OcrResult | null>(null)
const composedQuestion = ref<string>('')
let bodyOverflow = ''

watch(
  () => props.open,
  (v) => {
    if (v) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = bodyOverflow
      // Clear the preview when the sheet closes so a reopen starts
      // fresh (and the blob URL gets released).
      if (previewUrl.value) {
        URL.revokeObjectURL(previewUrl.value)
        previewUrl.value = null
      }
      result.value = null
      errorMsg.value = null
      composedQuestion.value = ''
    }
  },
)

onBeforeUnmount(() => {
  document.body.style.overflow = bodyOverflow
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

function close(): void {
  emit('update:open', false)
}

function triggerFilePicker() {
  fileInputEl.value?.click()
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = URL.createObjectURL(file)
  busy.value = true
  errorMsg.value = null
  result.value = null
  composedQuestion.value = ''
  try {
    const r = await recognizeSerialFromImage(file)
    result.value = r
    if (r.serial) {
      // Compose a default question the operator can edit.
      composedQuestion.value = `[Gép: ${r.serial}] Kérem a gép előéletét.`
    } else {
      composedQuestion.value = ''
      errorMsg.value = 'Nem találtam sorozatszámot a képen. Próbáld közelebbről / élesebben.'
    }
  } catch (e) {
    errorMsg.value = `Az OCR nem sikerült: ${(e as Error).message ?? e}`
  } finally {
    busy.value = false
    // Reset the input so the same file can be re-picked (after
    // editing the question, snapping a new photo should still work).
    target.value = ''
  }
}

function onSubmit() {
  const text = composedQuestion.value.trim()
  if (text.length === 0) return
  emit('submit', text)
  close()
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/55 backdrop-blur-sm p-0 md:p-4"
        data-testid="photo-ask-sheet"
        @click.self="close"
      >
        <div
          class="w-full md:max-w-md bg-canvas-1 border border-border-default md:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/50 max-h-[92dvh] overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Fényképezz a géptábláról"
        >
          <!-- Drag handle (mobile) -->
          <div class="md:hidden flex justify-center pt-2.5">
            <div class="w-10 h-1 rounded-full bg-border-default" />
          </div>

          <header class="px-4 pt-3 pb-2.5 flex items-center justify-between border-b border-border-subtle">
            <h2 class="text-[14px] font-semibold text-text-primary">
              Fénykép a géptábláról
            </h2>
            <button
              type="button"
              class="w-7 h-7 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Bezárás"
              data-testid="photo-ask-close"
              @click="close"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="px-4 py-3 space-y-3">
            <p class="text-[12.5px] text-text-secondary leading-relaxed">
              Készíts fényképet a gép adattáblájáról, vagy válassz egy
              meglévő képet. A sorozatszámot automatikusan kiolvassuk,
              és beillesztjük a kérdésedbe.
            </p>

            <input
              ref="fileInputEl"
              type="file"
              accept="image/*"
              capture="environment"
              class="hidden"
              data-testid="photo-ask-input"
              @change="onFileChange"
            />

            <!-- Two big buttons: snap vs pick from gallery. -->
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-12 rounded-lg bg-accent text-white font-medium text-[13.5px] hover:bg-accent/90 active:scale-[0.98] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 inline-flex items-center justify-center gap-2"
                data-testid="photo-ask-snap"
                @click="triggerFilePicker"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M3 7h2l1.5-2h7L15 7h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" />
                  <circle cx="10" cy="12" r="3.5" stroke="currentColor" stroke-width="1.5" />
                </svg>
                Fotó
              </button>
              <button
                type="button"
                class="h-12 rounded-lg bg-surface-2 border border-border-subtle text-text-primary font-medium text-[13.5px] hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 inline-flex items-center justify-center gap-2"
                data-testid="photo-ask-pick"
                @click="triggerFilePicker"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5" />
                  <circle cx="8" cy="8" r="1.5" fill="currentColor" />
                  <path d="M3 13l4-4 4 4 3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                Galéria
              </button>
            </div>

            <!-- Preview + result -->
            <div
              v-if="previewUrl || busy || result"
              class="rounded-lg border border-border-subtle bg-surface-2 p-2.5 space-y-2"
              data-testid="photo-ask-preview"
            >
              <div
                v-if="previewUrl"
                class="w-full h-32 rounded-md bg-canvas-1 overflow-hidden flex items-center justify-center"
              >
                <img
                  :src="previewUrl"
                  alt="Előnézet"
                  class="max-w-full max-h-full object-contain"
                />
              </div>
              <div
                v-if="busy"
                class="flex items-center gap-2 text-[12.5px] text-text-secondary"
                data-testid="photo-ask-busy"
              >
                <span
                  class="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                  aria-hidden="true"
                />
                <span>OCR fut…</span>
              </div>
              <div
                v-if="result && result.serial"
                class="space-y-1.5"
                data-testid="photo-ask-result"
              >
                <div class="flex items-baseline gap-2">
                  <span class="text-[10.5px] font-mono uppercase tracking-wider text-text-muted">Sorozatszám</span>
                  <span
                    class="font-mono text-[14px] font-semibold text-nct-soft"
                    data-testid="photo-ask-serial"
                  >{{ result.serial }}</span>
                  <span class="text-[10.5px] text-text-muted ml-auto">
                    {{ Math.round(result.confidence * 100) }}% bizonyosság
                  </span>
                </div>
                <textarea
                  v-model="composedQuestion"
                  rows="3"
                  class="w-full rounded-md bg-canvas-1 border border-border-default px-2.5 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 resize-none"
                  placeholder="A kérdés…"
                  data-testid="photo-ask-question"
                />
                <button
                  type="button"
                  class="w-full h-10 rounded-md bg-accent text-white font-semibold text-[13.5px] hover:bg-accent/90 active:scale-[0.98] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  data-testid="photo-ask-submit"
                  :disabled="composedQuestion.trim().length === 0"
                  @click="onSubmit"
                >
                  Kérdés küldése
                </button>
              </div>
              <div
                v-if="errorMsg"
                class="text-[12px] text-warning"
                data-testid="photo-ask-error"
              >
                {{ errorMsg }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
