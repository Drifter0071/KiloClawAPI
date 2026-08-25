<script setup lang="ts">
// src/components/PhotoAskSheet.vue
//
// Photo-to-ask rework (2026-08-24) — "sentence builder" edition.
//
// What changed vs. the Phase 8 first cut (and why):
//   * Gallery button REMOVED — the camera is the whole feature.
//     One input, `capture="environment"`, opens the camera directly.
//   * NO automatic question composition anymore. The old flow picked
//     a "most likely serial" and wrote "[Gép: 2026] Kérem a gép
//     előéletét." on its own — photographing a date sticker produced
//     the machine "2026". We never interpret now; we only show what
//     Tesseract read as tappable detail chips.
//   * Sentence builder: tapping a chip appends it to the draft,
//     the technician types freely between taps, then sends.
//   * Pack 1 OCR rework (2026-08-25): capture -> CROP -> cascade ->
//     (variant picker?) -> build. The technician frames just the text
//     block before we read it; the preprocessing cascade (band
//     removal, adaptive threshold, denoise) fights moiré/flicker
//     static; if every automatic pass reads poorly the human picks
//     the cleanest preprocessed thumbnail. Empty state offers voice
//     dictation as the escape hatch.
//   * The UI states what to do and what will happen at every stage:
//     capture -> crop -> processing -> build (+ explicit empty and
//     picker states).
//
// Privacy unchanged: the photo never leaves the phone — Tesseract.js
// runs locally; only the final composed question goes to AskPage
// through the same `submit` event (AskPage wiring untouched).

import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  recognizeSerialFromImage,
  releaseVariants,
  runOcrCascade,
} from '@/lib/ocrSerial'
import type { PhotoVariant } from '@/lib/ocrPreprocess'
import { extractDetails, type DetailTokens } from '@/lib/ocrTokens'
import PhotoCropStage from '@/components/PhotoCropStage.vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void
  (e: 'submit', question: string): void
  /** User asked for voice dictation instead (empty/failed read). */
  (e: 'dictate'): void
}>()

type Stage = 'capture' | 'crop' | 'processing' | 'variants' | 'build' | 'empty'

const fileInputEl = ref<HTMLInputElement | null>(null)
const previewUrl = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
const details = ref<DetailTokens | null>(null)
const draft = ref<string>('')
const lowConfidence = ref<boolean>(false)
const stage = ref<Stage>('capture')
/** Untouched capture — fallback when cropping is skipped/unavailable. */
const originalShot = ref<Blob | null>(null)
/** Last cascade result kept around for the manual variant picker. */
const pendingVariants = ref<PhotoVariant[]>([])
const draftEl = ref<HTMLTextAreaElement | null>(null)
let bodyOverflow = ''
// Invalidate in-flight OCR when the sheet is closed mid-read so a
// stale result can't repopulate a freshly reopened sheet.
let runId = 0

function releasePending(): void {
  releaseVariants(pendingVariants.value)
  pendingVariants.value = []
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = bodyOverflow
      runId++
      if (previewUrl.value) {
        URL.revokeObjectURL(previewUrl.value)
        previewUrl.value = null
      }
      releasePending()
      originalShot.value = null
      details.value = null
      draft.value = ''
      lowConfidence.value = false
      errorMsg.value = null
      stage.value = 'capture'
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

function triggerCapture(): void {
  fileInputEl.value?.click()
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  // Reset immediately so re-shooting the same scene still fires change.
  target.value = ''
  if (!file) return
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = URL.createObjectURL(file)
  errorMsg.value = null
  details.value = null
  draft.value = ''
  lowConfidence.value = false
  originalShot.value = file
  // Crop FIRST (Pack 1 A6): framing just the text block removes most
  // background clutter before any pixels are processed.
  stage.value = 'crop'
}

/** Shared pipeline tail: run recognition on `source`, then route to
 *  build / variant-picker / empty depending on how it went. */
async function runPipeline(source: Blob, myRun: number): Promise<void> {
  stage.value = 'processing'
  errorMsg.value = null
  try {
    const outcome = await runOcrCascade(source)
    if (myRun !== runId) return // closed mid-read — discard
    releasePending()
    pendingVariants.value = outcome.variants
    lowConfidence.value = outcome.needsPicker
    const d = extractDetails(outcome.best.text)
    // Unreliable read + alternatives available -> let the human pick
    // the cleanest preprocessing instead of showing garbage chips.
    if (outcome.needsPicker && outcome.variants.length > 0) {
      stage.value = 'variants'
      return
    }
    finishRead(d)
  } catch (err) {
    if (myRun !== runId) return
    errorMsg.value = `Az olvasás nem sikerült: ${(err as Error).message ?? err}`
    stage.value = 'empty'
  }
}

function finishRead(d: DetailTokens): void {
  if (d.ids.length === 0 && d.words.length === 0) {
    stage.value = 'empty'
  } else {
    details.value = d
    stage.value = 'build'
  }
}

function onCropConfirm(blob: Blob | null): void {
  const source = blob ?? originalShot.value
  if (!source) return
  void runPipeline(source, ++runId)
}

function onCropSkip(): void {
  if (!originalShot.value) return
  void runPipeline(originalShot.value, ++runId)
}

async function onPickVariant(v: PhotoVariant): Promise<void> {
  const myRun = ++runId
  stage.value = 'processing'
  errorMsg.value = null
  try {
    const r = await recognizeSerialFromImage(v.blob)
    if (myRun !== runId) return
    releasePending()
    pendingVariants.value = []
    lowConfidence.value = false // human already picked the best frame
    finishRead(extractDetails(r.text))
  } catch (err) {
    if (myRun !== runId) return
    errorMsg.value = `Az olvasás nem sikerült: ${(err as Error).message ?? err}`
    stage.value = 'empty'
  }
}

/** Append one extracted detail at the end of the draft. The
 *  technician writes freely between taps; we just keep single-space
 *  separation sane. */
function appendToken(t: string): void {
  const base = draft.value.trimEnd()
  draft.value = base.length > 0 ? `${base} ${t}` : t
}

function isUsed(t: string): boolean {
  return draft.value.toLocaleLowerCase('hu').includes(t.toLocaleLowerCase('hu'))
}

function clearDraft(): void {
  draft.value = ''
}

function retake(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = null
  }
  releasePending()
  originalShot.value = null
  details.value = null
  errorMsg.value = null
  stage.value = 'capture'
  nextTick(() => triggerCapture())
}

function onSubmit(): void {
  const text = draft.value.trim()
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
        class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60 p-0 md:p-4"
        data-testid="photo-ask-sheet"
        @click.self="close"
      >
        <div
          class="w-full md:max-w-md bg-canvas-2 border border-border-default md:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/50 max-h-[92dvh] overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Fotó a tábláról"
        >
          <!-- Drag handle (mobile) -->
          <div class="md:hidden flex justify-center pt-2.5">
            <div class="w-10 h-1 rounded-full bg-border-default" />
          </div>

          <header class="px-4 pt-3 pb-2.5 flex items-center justify-between border-b border-border-subtle">
            <h2 class="text-[14px] font-semibold text-text-primary">
              Fotó a tábláról
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

          <!-- Hidden camera input. capture=environment asks mobile
               browsers to open the rear camera directly; desktops fall
               back to a plain file dialog (still no gallery UI here). -->
          <input
            ref="fileInputEl"
            type="file"
            accept="image/*"
            capture="environment"
            class="hidden"
            data-testid="photo-ask-input"
            @change="onFileChange"
          />

          <!-- ------------------------------------------------ STEP GUIDE
               Only shown while capturing — later stages explain
               themselves inline, extra text would be noise. -->
          <div v-if="stage === 'capture'" class="px-4 py-3 space-y-3">
            <ol class="space-y-2.5" data-testid="photo-ask-steps">
              <li class="flex items-start gap-2.5">
                <span class="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-accent/12 text-nct-soft text-[11px] font-semibold flex items-center justify-center">1</span>
                <span class="text-[13px] text-text-primary leading-snug">Fotózd le a gép adattábláját.</span>
              </li>
              <li class="flex items-start gap-2.5">
                <span class="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-accent/12 text-nct-soft text-[11px] font-semibold flex items-center justify-center">2</span>
                <span class="text-[13px] text-text-secondary leading-snug">
                  Kiolvassuk róla a feliratot. Ez a telefonon történik — a kép nem kerül fel a szerverre.
                </span>
              </li>
              <li class="flex items-start gap-2.5">
                <span class="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-accent/12 text-nct-soft text-[11px] font-semibold flex items-center justify-center">3</span>
                <span class="text-[13px] text-text-secondary leading-snug">
                  Kiválasztod a fontos részleteket, közéjük írhatsz, és elküldöd a kérdést.
                </span>
              </li>
            </ol>

            <button
              type="button"
              class="w-full h-14 rounded-xl bg-accent text-text-inverse font-semibold text-[15px] hover:bg-accent-hover active:scale-[0.98] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 inline-flex items-center justify-center gap-2.5"
              data-testid="photo-ask-snap"
              aria-label="Kamera indítása"
              @click="triggerCapture"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 7h2l1.5-2h7L15 7h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" />
                <circle cx="10" cy="12" r="3.5" stroke="currentColor" stroke-width="1.5" />
              </svg>
              Tábla lefotózása
            </button>

            <p class="text-[11.5px] text-text-muted leading-relaxed">
              Tipp: jó fényben, merőlegesen fotózd, úgy hogy a teljes tábla látszódjon.
            </p>

            <p v-if="errorMsg" class="text-[12px] text-warning" data-testid="photo-ask-error">
              {{ errorMsg }}
            </p>
          </div>

          <!-- ------------------------------------------------ CROP
               Pack 1 (A6): frame just the text block. Skipping is
               always available; a failed export falls back to the
               original file inside the component. -->
          <div v-else-if="stage === 'crop'" class="px-4 py-3">
            <PhotoCropStage
              v-if="previewUrl"
              :src="previewUrl"
              @confirm="onCropConfirm"
              @skip="onCropSkip"
            />
          </div>

          <!-- ------------------------------------------------ PROCESSING -->
          <div v-else-if="stage === 'processing'" class="px-4 py-8" data-testid="photo-ask-busy">
            <div class="flex flex-col items-center gap-3">
              <div v-if="previewUrl" class="w-28 h-20 rounded-lg overflow-hidden bg-canvas-2 border border-border-subtle">
                <img :src="previewUrl" alt="Előnézet" class="w-full h-full object-cover" />
              </div>
              <span
                class="inline-block w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin"
                aria-hidden="true"
              />
              <p class="text-[13.5px] font-medium text-text-primary">Olvasom a képet…</p>
              <p class="text-[11.5px] text-text-muted">A felismerés a telefonon fut, pár másodperc.</p>
            </div>
          </div>

          <!-- ------------------------------------------------ VARIANTS
               Pack 1 (B10): every automatic pass read poorly — the
               human eye beats any auto-heuristic for picking the
               cleanest preprocessing. Tapping one runs a final OCR. -->
          <div v-else-if="stage === 'variants'" class="px-4 py-3 space-y-3" data-testid="photo-ask-variants">
            <p class="text-[13.5px] font-medium text-text-primary">
              A kép nehezen olvasható. Melyik változatot olvassuk be?
            </p>
            <p class="text-[11.5px] text-text-muted leading-snug">
              Koppints arra, amin a szöveg a legjobban látszik.
            </p>
            <div class="grid grid-cols-3 gap-2">
              <button
                v-for="v in pendingVariants"
                :key="v.label"
                type="button"
                class="rounded-lg overflow-hidden border border-border-subtle bg-canvas-2 hover:border-accent active:scale-[0.97] transition-all duration-150"
                data-testid="photo-ask-variant"
                :data-label="v.label"
                @click="onPickVariant(v)"
              >
                <img :src="v.url" :alt="`Előfeldolgozott változat: ${v.label}`" class="w-full h-20 object-cover" />
                <span class="block text-[10.5px] font-mono uppercase tracking-wide text-text-muted py-1">{{ v.label }}</span>
              </button>
            </div>
            <button
              type="button"
              class="w-full h-11 rounded-lg border border-border-subtle bg-surface text-[13px] font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150"
              data-testid="photo-ask-retake"
              @click="retake"
            >
              Újrafotózás
            </button>
          </div>

          <!-- ------------------------------------------------ EMPTY -->
          <div v-else-if="stage === 'empty'" class="px-4 py-6 space-y-3" data-testid="photo-ask-empty">
            <p class="text-[13.5px] font-medium text-text-primary">
              Nem találtunk olvasható szöveget a képen.
            </p>
            <p class="text-[12.5px] text-text-secondary leading-relaxed">
              Próbáld újra közelebbről és jobb megvilágításban — a teljes tábla legyen látható és éles.
            </p>
            <p v-if="errorMsg" class="text-[12px] text-warning" data-testid="photo-ask-error">
              {{ errorMsg }}
            </p>
            <button
              type="button"
              class="w-full h-11 rounded-lg bg-accent text-text-inverse font-semibold text-[13.5px] hover:bg-accent-hover active:scale-[0.98] transition-all duration-150"
              data-testid="photo-ask-retake"
              @click="retake"
            >
              Újrafotózás
            </button>
            <!-- Pack 1 (D3): OCR is one input path, not a dead end.
                   When the screen photo won't read, dictation is the
                   fastest honest fallback — and it already ships. -->
            <button
              type="button"
              class="w-full h-11 rounded-lg border border-border-subtle bg-surface text-[13px] font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150"
              data-testid="photo-ask-dictate"
              @click="emit('dictate'); close()"
            >
              Inkább diktálom
            </button>
          </div>

          <!-- ------------------------------------------------ BUILD -->
          <template v-else>
            <div class="px-4 pt-3 pb-3 space-y-3">
              <!-- Shot summary row: thumbnail + retake. No confidence
                   percentage — either the words are right or they are
                   not; a number invites misplaced trust. -->
              <div class="flex items-center gap-2.5">
                <div v-if="previewUrl" class="w-14 h-10 rounded-md overflow-hidden bg-canvas-2 border border-border-subtle shrink-0">
                  <img :src="previewUrl" alt="Előnézet" class="w-full h-full object-cover" />
                </div>
                <button
                  type="button"
                  class="h-8 px-3 rounded-md border border-border-subtle bg-surface text-[12px] font-medium text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150"
                  data-testid="photo-ask-retake"
                  @click="retake"
                >
                  Újrafotózás
                </button>
              </div>

              <p
                v-if="lowConfidence"
                class="text-[11.5px] text-warning leading-snug"
                data-testid="photo-ask-low-confidence"
              >
                Az olvasás bizonytalan volt — nézd át a felismert szavakat.
              </p>

              <!-- Identifier-shaped tokens first. Still just a tap
                   target: nothing is auto-selected or auto-assigned. -->
              <div v-if="details && details.ids.length > 0" class="space-y-1.5">
                <p class="text-[10.5px] font-mono uppercase tracking-wider text-text-muted">
                  Azonosítónak tűnik
                </p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="t in details.ids"
                    :key="`id-${t}`"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-mono font-medium transition-all duration-150 active:scale-[0.97]"
                    :class="isUsed(t)
                      ? 'border-accent/60 bg-accent/15 text-text-primary opacity-75'
                      : 'border-accent/35 bg-accent/10 text-nct-soft hover:border-accent/60'"
                    data-testid="photo-ask-chip"
                    :data-used="isUsed(t) ? 'true' : 'false'"
                    @click="appendToken(t)"
                  >
                    <svg v-if="isUsed(t)" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.5l2.5 2.5L9.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    {{ t }}
                  </button>
                </div>
              </div>

              <!-- Everything else the plate says, reading order. -->
              <div v-if="details" class="space-y-1.5">
                <p class="text-[10.5px] font-mono uppercase tracking-wider text-text-muted">
                  Minden más a képen
                </p>
                <p class="text-[11.5px] text-text-muted leading-snug">
                  Koppints egy részletre, és a kérdésed végére kerül. A szavak közé szabadon írhatsz.
                </p>
                <div class="flex flex-wrap gap-1.5" data-testid="photo-ask-chips">
                  <button
                    v-for="t in details.words"
                    :key="`w-${t}`"
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-all duration-150 active:scale-[0.97]"
                    :class="isUsed(t)
                      ? 'border-border-strong bg-canvas-2 text-text-primary opacity-75'
                      : 'bg-surface-2 border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary'"
                    data-testid="photo-ask-chip"
                    :data-used="isUsed(t) ? 'true' : 'false'"
                    @click="appendToken(t)"
                  >
                    <svg v-if="isUsed(t)" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.5l2.5 2.5L9.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    {{ t }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Sticky composer: the sentence builder itself. -->
            <div class="sticky bottom-0 -mx-0 px-4 py-3 bg-canvas-2 border-t border-border-subtle space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-[11px] font-mono uppercase tracking-wider text-text-muted" for="photo-ask-draft-field">
                  A kérdésed
                </label>
                <button
                  v-if="draft.length > 0"
                  type="button"
                  class="text-[11.5px] text-text-muted hover:text-warning transition-colors duration-150"
                  data-testid="photo-ask-clear"
                  @click="clearDraft"
                >
                  Törlés
                </button>
              </div>
              <textarea
                id="photo-ask-draft-field"
                ref="draftEl"
                v-model="draft"
                rows="2"
                class="w-full rounded-lg bg-canvas-2 border border-border-default px-3 py-2 text-[13.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 resize-none"
                placeholder="Írd ide a kérdésed, vagy koppints a részletekre…"
                data-testid="photo-ask-draft"
              />
              <button
                type="button"
                class="w-full h-11 rounded-lg bg-accent text-text-inverse font-semibold text-[14px] hover:bg-accent-hover active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                data-testid="photo-ask-submit"
                :disabled="draft.trim().length === 0"
                @click="onSubmit"
              >
                Kérdés küldése
              </button>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
