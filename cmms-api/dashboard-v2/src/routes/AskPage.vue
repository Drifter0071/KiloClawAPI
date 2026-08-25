<script setup lang="ts">
// src/routes/AskPage.vue
//
// V2 chat surface — the operator's main workspace.
//
// Layout:
//   - A single scrollable message region in the centre of the workspace,
//     with a maximum reading width of 860px on desktop and full width on
//     mobile.
//   - User messages align right with a subtle brand-tinted surface.
//     Assistant messages align left using 100% of the reading rail.
//   - A single docked composer at the bottom of the workspace when active,
//     or in the hero area when empty (NEVER double inputs on mobile).
//   - When a sorszam is tapped, the in-place right-side <TicketPanel>
//     opens in a column on desktop and as a bottom sheet on mobile.
//   - Scroll behaviour: only the message region scrolls. The composer
//     stays fixed.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AgentBody from '@/components/AgentBody.vue'
import AskBar from '@/components/AskBar.vue'
import AskThreadBar from '@/components/AskThreadBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
import AnswerVoteBar from '@/components/AnswerVoteBar.vue'
import Button from '@/components/Button.vue'
import CorrectionModal from '@/components/CorrectionModal.vue'
import MachineScopeBar from '@/components/MachineScopeBar.vue'
import Skeleton from '@/components/Skeleton.vue'
import SorszamLink from '@/components/SorszamLink.vue'
import SmartChips from '@/components/SmartChips.vue'
import FollowUpChips from '@/components/FollowUpChips.vue'
import PhotoAskSheet from '@/components/PhotoAskSheet.vue'
import TicketInspector from '@/components/TicketInspector.vue'
import TicketPanel from '@/components/TicketPanel.vue'
import { useApi } from '@/composables/useApi'
import {
  AgentStreamFailedError,
  consumeAgentStream,
} from '@/composables/useAgentStream'
import { useMachineScope } from '@/composables/useMachineScope'
import { useVoiceInput } from '@/composables/useVoiceInput'
import VoiceDictationSheet from '@/components/VoiceDictationSheet.vue'
import { consumeSeedQ, setSeedQ } from '@/composables/useSeedQ'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useMyVotes } from '@/composables/useMyVotes'
import { useMyCorrections } from '@/composables/useMyCorrections'
import { useToast } from '@/composables/useToast'
import { useAskStore } from '@/stores/ask'
import { renderAnswer, type AnswerView, type EvidenceRow } from '@/lib/renderAnswer'
import { humanizeError } from '@/lib/errors'
import type {
  AgentContextScope,
  AgentHistoryTurn,
  AnswerAgentRequest,
  AnswerAgentResponse,
  AnswerResponse,
  EvidenceTicket,
} from '@/lib/api'

const store = useAskStore()

// Machine-scoped ask (feature #6): shared singleton ref — the scope
// picker (MachineScopeBar) writes it, buildContextPayload() reads it
// into `context.device`.
const { device: scopeDeviceRef } = useMachineScope()

// ---------------------------------------------------------------------------
// Layout / responsive
// ---------------------------------------------------------------------------

const isMobile = useMediaQuery('(max-width: 767px)')

// ---------------------------------------------------------------------------
// Feedback (👍 / 👎) — pre-hydrate the user's prior votes for every
// rendered assistant bubble. The AnswerVoteBar below each bubble reads
// its initial state from this composable; on a click it round-trips
// to the server and then calls castLocal() to keep the cache hot.
// ---------------------------------------------------------------------------

const myVotes = useMyVotes()
const myCorrections = useMyCorrections()

/** All answer_ids currently visible in the chat. Re-tracked on every
 *  chat mutation so newly-landed answers get hydrated too. */
const renderedAnswerIds = computed<string[]>(() => {
  const out: string[] = []
  for (const m of store.messages) {
    const a = (m.meta as { agent?: { answer_id?: string } } | undefined)?.agent
    if (a?.answer_id) out.push(a.answer_id)
    const r = (m.meta as { answer?: { answer_id?: string } } | undefined)?.answer
    if (r?.answer_id) out.push(r.answer_id)
  }
  return out
})
myVotes.watchIds(() => renderedAnswerIds.value)
myCorrections.watchIds(() => renderedAnswerIds.value)

// ---------------------------------------------------------------------------
// "Tudod a helyes választ? Küldd el a fejlesztésnek!" inline link
//
// When the user dislikes an answer, the AnswerVoteBar emits
// `dislike-confirmed`. We track those answer_ids in `dislikedIds`
// (Set, so duplicates are deduped) and render the link below the
// affected answer bubble. Clicking the link opens CorrectionModal;
// on submit we POST /v1/feedback/correction AND write to the
// `myCorrections` cache so the inline "Visszajelzés elküldve ✓"
// state appears (and persists across reloads, like the thumb
// buttons). No chat message is appended — the correction is a
// meta-action sent to the dev team, not a turn in the conversation,
// so we don't echo it as an AI-style reply.
// ---------------------------------------------------------------------------

const api = useApi()
const toast = useToast()

// ---------------------------------------------------------------------------
// Voice input (feature #5) — Hungarian dictation via the Web Speech API.
// The mic button lives in AskBar; final transcripts are appended to the
// input, errors surface as a toast. `supported` stays false in browsers
// without SpeechRecognition and AskBar then hides the mic entirely.
//
// Hands-free (2026-08-24 mobile-first): the same mic can be long-pressed
// to open VoiceDictationSheet, where the mic stays on across phrases
// and auto-submits after 1.2s of silence. The sheet lives in a
// Teleport so it can overlay the whole chat surface safely.
// ---------------------------------------------------------------------------

const voice = useVoiceInput()
const voiceSupported = computed(() => voice.supported.value)
const voiceListening = computed(() => voice.listening.value)
const handsFreeOpen = ref(false)
const photoAskOpen = ref(false)
const unsubscribeVoice = voice.onFinal((text) => {
  const joined = [q.value.trim(), text.trim()].filter(Boolean).join(' ')
  q.value = joined
})
watch(voice.error, (err) => {
  if (err) toast.error(err)
})
function onMicToggle(): void {
  voice.toggle()
}
function onMicHandsFree(): void {
  if (!voiceSupported.value) return
  handsFreeOpen.value = true
}
/** Photo flow gave up on OCR — hand over to dictation (Pack 1 D3).
 *  The sheet closes itself before emitting; we just open the mic. */
function onPhotoDictate(): void {
  if (!voiceSupported.value) return
  photoAskOpen.value = false
  handsFreeOpen.value = true
}
function onHandsFreeSubmit(text: string): void {
  // The sheet closes itself when it emits submit. Set the input then
  // push it through the normal question pipeline so the chat history,
  // store, and ask-thread routing behave identically to typed input.
  q.value = text
  // Defer to next tick so v-model flushes before submitQuestion reads it.
  nextTick(() => submitQuestion(text))
}
const dislikedIds = ref<Set<string>>(new Set())
const correctionFor = ref<string | null>(null)
const correctionBusy = ref(false)

function onDislikeConfirmed(payload: { answerId: string }): void {
  // Set is reactive via reassignment, not mutation — `ref(new Set())`
  // wraps the Set in a ref but mutations to the Set's contents
  // don't trigger updates. We create a fresh Set on each change so
  // watchers (and the v-if below) reliably re-render.
  const next = new Set(dislikedIds.value)
  next.add(payload.answerId)
  dislikedIds.value = next
}

function onDislikeCleared(payload: { answerId: string }): void {
  if (!dislikedIds.value.has(payload.answerId)) return
  const next = new Set(dislikedIds.value)
  next.delete(payload.answerId)
  dislikedIds.value = next
  // Drop the cached correction too — the link is gated on the
  // dislike state, so removing the dislike should also remove the
  // "Visszajelzés elküldve" label. (If the user re-dislikes, the
  // server-side correction is still there and will re-appear in
  // the next `loadMyCorrections` refresh.)
  myCorrections.clearLocal(payload.answerId)
}

function openCorrection(answerId: string): void {
  correctionFor.value = answerId
}

function closeCorrection(): void {
  if (correctionBusy.value) return
  correctionFor.value = null
}

async function submitCorrection(correction: string): Promise<void> {
  const answerId = correctionFor.value
  if (!answerId) return
  correctionBusy.value = true
  try {
    const r = await api.submitFeedbackCorrection({ answer_id: answerId, correction })
    // Write to the in-memory + localStorage cache so the inline
    // "Visszajelzés elküldve ✓" state appears immediately, and so
    // a page reload renders the same state without a re-fetch.
    myCorrections.castLocal(answerId, { correction, created_at: r.created_at })
    // The link is now in the "sent" state — the user can still
    // open the modal again to submit a refined correction, so we
    // just close it.
    correctionFor.value = null
  } catch (e) {
    toast.error('A helyes válasz nem ment el. Próbáld újra.')
    // eslint-disable-next-line no-console
    console.error('[feedback] correction failed', e)
  } finally {
    correctionBusy.value = false
  }
}

const composerSize = computed<'lg' | 'md'>(() => {
  if (isMobile.value && store.messages.length === 0) return 'lg'
  return 'md'
})

// ---------------------------------------------------------------------------
// Question state
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
const errorText = ref<string | null>(null)

const chatScroll = ref<HTMLElement | null>(null)
const userAtBottom = ref(true)

/** Same-thread context carry + machine scope: the payload is captured
 *  AT SUBMIT TIME (before the new user message is pushed) so follow-ups
 *  like "és a másik gép?" see the prior exchange, and the machine-scope
 *  picker feeds `context.device`. */
const runPayloads = ref<Record<number, AnswerAgentRequest>>({})

function detectLang(text: string): 'hu' | 'en' {
  return /[^\x00-\x7F]/.test(text) ? 'hu' : 'en'
}

const AGENT_POLL_INTERVAL_MS = 3000
const AGENT_POLL_MAX_ATTEMPTS = 200 // 10 minutes — complex questions can take minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const HISTORY_TURNS = 6

/** Build the `history` payload from the ACTIVE thread: the last
 *  `HISTORY_TURNS` user/assistant messages, skipping error and
 *  correction bubbles. `skipLastUser` drops a trailing user message
 *  that is itself the in-flight question (retry path — avoid
 *  duplicating it). */
function buildHistoryPayload(skipLastUser = false): AgentHistoryTurn[] {
  const msgs = store.messages
  let end = msgs.length
  if (skipLastUser && end > 0 && msgs[end - 1]?.role === 'user') end -= 1
  const out: AgentHistoryTurn[] = []
  for (let i = end - 1; i >= 0 && out.length < HISTORY_TURNS; i -= 1) {
    const m = msgs[i]!
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.meta?.error || m.meta?.correction) continue
    out.unshift({ role: m.role, text: m.text.slice(0, 2000) })
  }
  return out
}

function buildContextPayload(): AgentContextScope | undefined {
  const scopeDevice = scopeDeviceRef.value.trim()
  if (scopeDevice.length === 0) return undefined
  return { device: scopeDevice }
}

function buildRequestPayload(qText: string, skipLastUser = false, clearScope = false): AnswerAgentRequest {
  const payload: AnswerAgentRequest = { q: qText, language: detectLang(qText) }
  const history = buildHistoryPayload(skipLastUser)
  if (history.length > 0) payload.history = history
  // clearScope=true skips the `context.device` injection even when the
  // operator has a machine selected. Used by the SmartChips "Általános"
  // chip so the user can fire a generic question without first
  // un-selecting the machine in the scope bar.
  const context = clearScope ? undefined : buildContextPayload()
  if (context) payload.context = context
  return payload
}

/**
 * Fallback ask flow (async job): the zrok edge cuts proxied responses
 * at ~60s, so when the SSE stream is unavailable (proxy mismatch, old
 * server, transport truncation) we POST an async job, get a { job_id }
 * back immediately, and poll until it is done — the agent is NOT
 * time-limited on this path. Carries the SAME payload (history +
 * context), so the fallback is invisible to the user.
 */
async function askViaPoll(payload: AnswerAgentRequest): Promise<AnswerAgentResponse> {
  const api = useApi()
  const job = await api.answerAgentAsync(payload)
  // Legacy proxy fallback: an old dashboard/server.ts returns the answer
  // directly instead of a job handle — accept it as-is.
  if ('final_text' in job) return job as unknown as AnswerAgentResponse
  // 503 from the dashboard proxy means "cmms-api temporarily unavailable"
  // (deploy / ETL / overloaded). Tolerate up to N consecutive 503s
  // before giving up — a single bad poll shouldn't kill the wait, but
  // a sustained outage should surface quickly. 404 (job vanished from
  // a restart) and other 5xx still abort immediately.
  let consecutive503 = 0
  const MAX_CONSECUTIVE_503 = 5
  for (let attempt = 0; attempt < AGENT_POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(AGENT_POLL_INTERVAL_MS)
    let state: Awaited<ReturnType<typeof api.answerAgentPoll>>
    try {
      state = await api.answerAgentPoll(job.job_id)
      consecutive503 = 0
    } catch (e) {
      const status = typeof e === 'object' && e !== null ? (e as { status?: number }).status : undefined
      if (status === 404) {
        throw new Error('A válasz készítése megszakadt (a szerver újraindult). Kérdezd újra.')
      }
      if (status === 503) {
        consecutive503 += 1
        if (consecutive503 >= MAX_CONSECUTIVE_503) {
          throw new Error('A háttérszolgáltatás átmenetileg nem elérhető. Kérdezd újra egy perc múlva.')
        }
        continue
      }
      throw e
    }
    if (state.status === 'done' && state.result) return state.result
    if (state.status === 'error') {
      throw new Error(state.error?.message ?? 'A válasz elkészítése meghiúsult.')
    }
  }
  throw new Error('A válasz elkészítése túl sokáig tartott. Kérdezd újra.')
}

// ---------------------------------------------------------------------------
// Streaming state — the live "progressive disclosure" bubble
// ---------------------------------------------------------------------------

const streamingActive = ref(false)
const streamingPhase = ref<'start' | 'searching' | 'synthesizing' | 'soft_deadline'>('start')
const streamingText = ref('')
const streamingTools = ref<Array<{ id: number; name: string; args: Record<string, unknown>; ok?: boolean; note?: string; summary?: string }>>([])
let toolSeq = 0

function resetStream(): void {
  streamingActive.value = true
  streamingPhase.value = 'start'
  streamingText.value = ''
  streamingTools.value = []
}

function streamHandlers() {
  return {
    onStatus(phase: 'start' | 'searching' | 'synthesizing' | 'soft_deadline') {
      streamingPhase.value = phase
    },
    onToolStart(name: string, args: Record<string, unknown>) {
      streamingTools.value = [...streamingTools.value, { id: ++toolSeq, name, args }]
    },
    onToolDone(name: string, ok: boolean, note: string | undefined, summary: string | undefined) {
      const next = [...streamingTools.value]
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i]!.name === name && next[i]!.ok === undefined) {
          next[i] = { ...next[i]!, ok, note, summary }
          break
        }
      }
      streamingTools.value = next
    },
    onToken(text: string) {
      streamingText.value += text
    },
  }
}

const PHASE_LABELS: Record<string, string> = {
  start: 'Indítom…',
  searching: 'Keresek a ticketekben…',
  synthesizing: 'Összefoglalom a választ…',
  soft_deadline: 'Időszűkében — összefoglalom…',
}

const phaseLabel = computed(() => PHASE_LABELS[streamingPhase.value] ?? 'Dolgozom…')

// ---------------------------------------------------------------------------
// Ask execution — stream first, async-poll fallback
// ---------------------------------------------------------------------------

/** Routes a completed answer into the right thread (same logic the
 *  vue-query watcher used to own). */
function finalizeAnswer(data: AnswerAgentResponse, runToken: number, submitKey: string) {
  if (handledRun >= runToken) return
  handledRun = runToken
  streamingActive.value = false
  store.busy = false
  // The thread the question was ASKED in (submitKey) is the anchor — if
  // the user has navigated away mid-flight, we land the answer there and
  // DON'T teleport them back. Otherwise we honour the auto-split
  // behaviour (move the user question + answer to the resolved thread).
  const route = store.pickThreadForAnswer(data, submitKey)
  if (route.shouldSwitchActive) {
    store.moveTrailingQuestion(submitKey, route.threadKey)
    store.switchThread(route.threadKey)
  }
  store.pushForThread(route.threadKey, {
    role: 'assistant',
    text: data.final_text,
    ts: Date.now(),
    meta: { agent: data },
  })
  store.clearPendingRun(runToken)
  delete runPayloads.value[runToken]
  if (userAtBottom.value) scrollToLatestMessage()
}

/** Pushes an error bubble into the submit thread (hard-fail contract:
 *  no deterministic fallback, the user sees the real failure). */
function handleFailure(err: unknown, runToken: number, submitKey: string) {
  if (handledRun >= runToken) return
  handledRun = runToken
  streamingActive.value = false
  store.busy = false
  let title = 'A válasz elkészítése meghiúsult.'
  let description = ''
  if (err instanceof AgentStreamFailedError) {
    description = err.message
  } else {
    const h = humanizeError(err)
    title = h.title
    description = h.description
  }
  errorText.value = description
  // Errors have no resolved customer — write the error to the submit
  // thread and don't auto-split.
  store.pushForThread(submitKey, {
    role: 'assistant',
    text: title,
    ts: Date.now(),
    meta: { error: description },
  })
  store.clearPendingRun(runToken)
  delete runPayloads.value[runToken]
  if (userAtBottom.value) scrollToLatestMessage()
}

async function pollFallback(payload: AnswerAgentRequest, runToken: number, submitKey: string): Promise<void> {
  try {
    const data = await askViaPoll(payload)
    finalizeAnswer(data, runToken, submitKey)
  } catch (e) {
    handleFailure(e, runToken, submitKey)
  }
}

/**
 * The streaming ask flow (2026-08-19): POST /v1/answer-agent/stream and
 * consume the SSE frames live (progressive disclosure + true token
 * streaming). When the stream is unavailable — fetch fails, non-2xx, or
 * the content-type isn't text/event-stream (old proxy) — we fall back to
 * the async-poll flow with the SAME payload. An `error` SSE frame is a
 * definitive agent failure and is shown as-is (hard-fail contract).
 */
async function ask(runToken: number): Promise<void> {
  const payload = runPayloads.value[runToken]
  if (!payload) return
  const submitKey = store.consumePendingRun(runToken) ?? store.threadKey
  try {
    const res = await api.answerAgentStream(payload)
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('text/event-stream')) {
      await pollFallback(payload, runToken, submitKey)
      return
    }
    resetStream()
    const outcome = await consumeAgentStream(res, streamHandlers())
    finalizeAnswer(outcome, runToken, submitKey)
  } catch (e) {
    if (e instanceof AgentStreamFailedError) {
      handleFailure(e, runToken, submitKey)
    } else {
      // Transport error / EOF without answer → async-poll fallback.
      streamingActive.value = false
      await pollFallback(payload, runToken, submitKey)
    }
  } finally {
    streamingActive.value = false
    store.busy = false
  }
}

// ---------------------------------------------------------------------------
// Submit flows
// ---------------------------------------------------------------------------

function scrollToLatestMessage() {
  nextTick(() => {
    const scroller = chatScroll.value
    if (!scroller) return
    const messages = scroller.querySelectorAll(
      '[data-testid="user-message"], [data-testid="assistant-error"], [data-testid="assistant-agent"], [data-testid="assistant-answer"]',
    )
    const last = messages[messages.length - 1] as HTMLElement | undefined
    if (!last) {
      scroller.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const containerRect = scroller.getBoundingClientRect()
    const msgRect = last.getBoundingClientRect()
    const delta = msgRect.top - containerRect.top
    const targetTop = scroller.scrollTop + delta - 24
    scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  })
}

function submitQuestion(text: string, clearScope = false) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  // Sending ends an active tap-mode dictation (GBoard closes the
  // keyboard on send). Without this the continuous 2026-08-25 tap-mic
  // would keep streaming fragments into the NEXT question's input.
  if (voice.listening.value && voice.mode.value === 'tap') voice.stopTap()
  currentQ.value = trimmed
  store.busy = true
  run.value += 1
  // Capture the payload BEFORE pushing the user message — the new
  // question must NOT be included in its own `history`.
  runPayloads.value[run.value] = buildRequestPayload(trimmed, false, clearScope)
  store.push({ role: 'user', text: trimmed, ts: Date.now() })
  q.value = ''
  // Record the thread this question was asked in so the answer lands
  // in the SAME thread even if the user has navigated to a different
  // chat by the time the response comes back.
  store.registerPendingRun(run.value, store.threadKey)
  errorText.value = null
  scrollToLatestMessage()
  void ask(run.value)
}

function runConfirmed(view: AnswerView) {
  currentQ.value = view.q
  store.busy = true
  run.value += 1
  runPayloads.value[run.value] = buildRequestPayload(view.q)
  store.push({ role: 'user', text: view.q, ts: Date.now() })
  store.registerPendingRun(run.value, store.threadKey)
  errorText.value = null
  scrollToLatestMessage()
  void ask(run.value)
}

function refineQuestion() {
  q.value = ''
  errorText.value = null
  nextTick(() => document.getElementById('ask-input')?.focus())
}

function onTicketOpenInAsk(sorszam: string) {
  if (!sorszam) return
  const text = `ticket ${sorszam}`
  q.value = text
  errorText.value = null
  nextTick(() => {
    const el = document.getElementById('ask-input') as HTMLInputElement | null
    el?.focus()
    el?.select?.()
  })
}

/**
 * SmartChips event handler (Phase 8, 2026-08-24, A2 in the brainstorm).
 * Forwards to `submitQuestion` with the optional `clearScope` flag
 * (set when the operator tapped "Általános" while a device is scoped).
 */
function onSmartChipPick(payload: { text: string; clearScope: boolean }): void {
  submitQuestion(payload.text, payload.clearScope)
}

/**
 * Copy a shareable answer URL to the clipboard. Phase 8 (2026-08-24,
 * F4) — the operator taps "Megosztás" on an agent bubble, and the
 * SPA copies `/dashboard/v2/answer/<id>` to the system clipboard.
 * The colleague opens the link, logs in, and sees the original
 * answer in a read-only view (SharedAnswerPage). Login-required,
 * permanent URL.
 */
async function onShareAnswer(answerId: string): Promise<void> {
  const url = `${window.location.origin}/dashboard/v2/answer/${encodeURIComponent(answerId)}`
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url)
    } else {
      // Legacy fallback (some Android webviews, older Firefox).
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    // Button-level feedback (2026-08-24): the toast alone was too easy
    // to miss on a phone — flip the pressed button itself to
    // "Kimásolva ✓" for two seconds.
    copiedShareId.value = answerId
    if (copiedShareTimer !== null) clearTimeout(copiedShareTimer)
    copiedShareTimer = setTimeout(() => {
      copiedShareId.value = null
      copiedShareTimer = null
    }, 2000)
    toast.success('Hivatkozás a vágólapon — oszd meg kollégáddal!')
  } catch {
    toast.error('Nem sikerült a vágólapra másolás.')
  }
}

/** The agent bubble whose share link was just copied (null = none). */
const copiedShareId = ref<string | null>(null)
let copiedShareTimer: ReturnType<typeof setTimeout> | null = null

function retryLast() {
  if (currentQ.value.length === 0) return
  store.busy = true
  errorText.value = null
  run.value += 1
  // skipLastUser: the failed question is still the last message in the
  // thread — drop it from `history` so the retry doesn't duplicate it.
  runPayloads.value[run.value] = buildRequestPayload(currentQ.value, true)
  // Re-register the submit thread for the retry — the original
  // pending entry was cleared when the error handler ran, and the
  // retry should re-anchor the next response to the thread the
  // user is currently looking at.
  store.registerPendingRun(run.value, store.threadKey)
  void ask(run.value)
}

/**
 * Retry after an error bubble: removes the failed user message +
 * error response from the chat, then resends the original question.
 * This gives the user a clean slate without leftover error artifacts.
 */
function retryFromError(errorIdx: number) {
  const msgs = store.messages
  // The user message that triggered this error is the one immediately
  // before the error bubble in the same thread.
  const userMsgIdx = errorIdx - 1
  if (userMsgIdx < 0 || msgs[userMsgIdx]?.role !== 'user') return
  const originalQ = msgs[userMsgIdx]!.text
  // Remove both the user message and the error response
  store.spliceMessages(userMsgIdx, 2)
  errorText.value = null
  // Re-submit
  submitQuestion(originalQ)
}

function jumpToLatest() {
  scrollToLatestMessage()
}

// ---------------------------------------------------------------------------
// Scroll tracking — "Ugrás a legújabb" pill
// ---------------------------------------------------------------------------

function onScroll() {
  const el = chatScroll.value
  if (!el) return
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop
  userAtBottom.value = distance < 80
}

let scrollEl: HTMLElement | null = null
watch(chatScroll, (el, prev) => {
  scrollEl = el
  if (prev) prev.removeEventListener('scroll', onScroll)
  if (el) el.addEventListener('scroll', onScroll, { passive: true })
})

// ---------------------------------------------------------------------------
// Query lifecycle → chat history
// ---------------------------------------------------------------------------

let handledRun = 0

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

function asTicket(row: EvidenceRow): EvidenceTicket {
  return {
    sorszam: row.sorszam,
    key: row.sorszam,
    reported_at_iso: '',
    snippet: row.snippet,
    kategoria: row.kategoria,
    kategoria_inferred: null,
    sulyossag_inferred: null,
  }
}

function evidenceFor(meta: AnswerResponse | undefined): EvidenceRow[] {
  if (!meta) return []
  const v = renderAnswer(meta)
  const all: EvidenceRow[] = []
  for (const g of v.evidence) {
    for (const t of g.tickets) all.push(t)
  }
  return all
}

const typing = computed(() => store.busy)

// Elapsed-seconds ticker for the "Gondolkodom…" indicator — complex
// questions legitimately take minutes now (async job, no time limit),
// so the operator needs to see that the agent is still working.
const waitSeconds = ref(0)
let waitTimer: ReturnType<typeof setInterval> | null = null
watch(typing, (t) => {
  if (t) {
    waitSeconds.value = 0
    waitTimer = setInterval(() => { waitSeconds.value += 1 }, 1000)
  } else if (waitTimer) {
    clearInterval(waitTimer)
    waitTimer = null
  }
})
onBeforeUnmount(() => {
  if (waitTimer) {
    clearInterval(waitTimer)
    waitTimer = null
  }
})

const EXAMPLE_CHIPS: string[] = []
// (Phase 8, 2026-08-24: the static starter chips moved into the new
// <SmartChips> component so they can switch to a per-device set when
// a machine is scoped. The constant is kept empty to keep the
// ask.spec.ts test surface stable; remove once tests migrate.)

const GREETINGS: string[] = [
  'Kérdezz bármit a ticketekről, gépekről vagy ügyfelekről.',
  'Mi romlott el ma?',
  'Mintát keresel?',
  'Kell egy összefoglaló a múlt hónapról?',
  'Melyik gép a leghangosabb mostanában?',
  'Hogyan áll a várólista?',
  'Mit szeretnél tudni egy ügyfélről?',
  'Melyik vezérlő adja fel legtöbbször?',
  'Mikor volt utoljára kritikus hiba?',
  'Mi változott a CMMS-ben a héten?',
]

const greetingIdx = Math.floor(Math.random() * GREETINGS.length)
const greeting = ref(GREETINGS[greetingIdx]!)

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Ticket inspector + ticket panel
// ---------------------------------------------------------------------------

const inspectorOpen = ref(false)
const inspectorTicket = ref<EvidenceTicket | null>(null)

const panelOpen = ref(false)
const panelSorszam = ref<string | null>(null)
const panelTicket = computed<EvidenceTicket | null>(() => {
  if (!panelSorszam.value) return null
  return {
    sorszam: panelSorszam.value,
    key: panelSorszam.value,
    reported_at_iso: '',
    snippet: '',
    kategoria: null,
    kategoria_inferred: null,
    sulyossag_inferred: null,
  }
})

function openTicket(row: EvidenceRow) {
  // On mobile, use the teleported inspector (overlay sheet).
  // On desktop, use the in-place right-side panel.
  if (isMobile.value) {
    inspectorTicket.value = asTicket(row)
    inspectorOpen.value = true
  } else {
    panelSorszam.value = row.sorszam
    panelOpen.value = true
  }
}

function closeInspector() {
  inspectorOpen.value = false
}

function onSorszamClick(payload: { prefix: 'B' | 'M'; sorszam: string }) {
  if (payload.prefix === 'M') {
    setSeedQ(payload.sorszam)
    return
  }
  // On mobile, use the teleported inspector (overlay sheet).
  // On desktop, use the in-place right-side panel.
  if (isMobile.value) {
    inspectorTicket.value = {
      sorszam: payload.sorszam,
      key: payload.sorszam,
      reported_at_iso: '',
      snippet: '',
      kategoria: null,
      kategoria_inferred: null,
      sulyossag_inferred: null,
    }
    inspectorOpen.value = true
  } else {
    panelSorszam.value = payload.sorszam
    panelOpen.value = true
  }
}

function closePanel() {
  panelOpen.value = false
}

// ---------------------------------------------------------------------------
// seedQ handoff
// ---------------------------------------------------------------------------

onMounted(() => {
  const seed = consumeSeedQ()
  if (seed && seed.length > 0) {
    q.value = seed
    submitQuestion(seed)
  } else if (store.messages.length > 0) {
    scrollToLatestMessage()
  }
})

onBeforeUnmount(() => {
  if (scrollEl) scrollEl.removeEventListener('scroll', onScroll)
  unsubscribeVoice()
})
</script>

<template>
  <div class="h-full flex flex-col min-h-0 relative overflow-hidden" data-testid="ask-page">
    <!-- ============================================================ -->
    <!-- Chat scroll area (single owned scroll container)             -->
    <!-- ============================================================ -->
    <div
      ref="chatScroll"
      class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-6 pb-6 md:pb-6"
      data-testid="ask-scroll"
    >
      <!-- Empty state -->
      <div
        v-if="store.messages.length === 0"
        class="min-h-full flex items-center justify-center py-8"
        data-testid="ask-empty"
      >
        <div class="w-full max-w-[860px] mx-auto space-y-8 text-center">
          <!-- Greeting -->
          <div class="space-y-3">
            <div
              class="inline-flex items-center gap-2 px-3 py-1 rounded-full
                     bg-shell-rail-elevated border border-shell-rail-border
                     text-[11px] font-mono uppercase tracking-wider text-shell-rail-muted"
              data-testid="ask-empty-chip"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-nct-soft" aria-hidden="true" />
              NCT Szerviz Ai · v2
            </div>
            <h1
              class="text-[26px] md:text-[32px] font-semibold tracking-tight text-chat-read-text leading-tight"
              data-testid="ask-greeting"
            >
              {{ greeting }}
            </h1>
            <p
              class="text-[14px] text-chat-read-muted max-w-lg mx-auto leading-relaxed"
              data-testid="ask-empty-tagline"
            >
              Belső karbantartási asszisztens — ticketek, gépek, ügyfelek,
              visszatérő minták. A CMMS adataiból dolgozik, magyarul válaszol.
            </p>
          </div>

          <!-- Hero composer (SINGLE input on empty state) -->
          <div class="max-w-2xl mx-auto w-full space-y-3">
            <div class="flex items-center justify-center">
              <MachineScopeBar />
            </div>
            <!-- Mobile-only "kéz használata nélkül" chip — discoverable
                 alternative to the long-press gesture on the mic. -->
            <div v-if="voiceSupported" class="md:hidden flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                class="h-8 px-3 rounded-full text-[12px] font-medium
                       bg-surface-2 border border-border-subtle text-text-secondary
                       hover:text-text-primary hover:border-border-strong
                       transition-colors duration-150
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                       inline-flex items-center gap-1.5"
                data-testid="handsfree-chip"
                @click="onMicHandsFree"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <rect x="7" y="2.5" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.5" />
                  <path d="M5 10a5 5 0 0 0 10 0M10 15v2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <span>Kéz használata nélkül</span>
              </button>
              <!-- Photo-to-ask sentence builder (reworked 2026-08-24).
                   Tap to open the photo OCR sheet; the operator snaps
                   a machine plate, taps the extracted details into a
                   draft question, and sends. -->
              <button
                type="button"
                class="h-8 px-3 rounded-full text-[12px] font-medium
                       bg-surface-2 border border-border-subtle text-text-secondary
                       hover:text-text-primary hover:border-border-strong
                       transition-colors duration-150
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                       inline-flex items-center gap-1.5"
                data-testid="photo-ask-chip"
                @click="photoAskOpen = true"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M3 7h2l1.5-2h7L15 7h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" />
                  <circle cx="10" cy="12" r="3.5" stroke="currentColor" stroke-width="1.5" />
                </svg>
                <span>Fotó</span>
              </button>
            </div>
            <AskBar
              v-model="q"
              size="lg"
              rounded="lg"
              input-id="ask-input"
              placeholder="Kérdezd a NCT Szerviz Ai-t…"
              :disabled="typing"
              :mic="voiceSupported"
              :mic-listening="voiceListening"
              :mic-hands-free-hint="true"
              @submit="submitQuestion"
              @mic-toggle="onMicToggle"
              @mic-handsfree="onMicHandsFree"
            />
            <div class="md:hidden flex justify-center">
              <AskThreadBar />
            </div>
          </div>

          <!-- Starter chips (Phase 8, 2026-08-24). Replaced the static
               EXAMPLE_CHIPS array with the new <SmartChips> component
               so the chips are context-aware: when a machine is
               scoped, the chip set switches to per-machine one-tap
               questions (M17191 előélet, M17191 hibakódok, …). The
               generic "Általános" chip clears the scope and fires
               a default generic question. -->
          <SmartChips @pick="onSmartChipPick" />
        </div>
      </div>

      <!-- Active conversation -->
      <div
        v-else
        :class="[
          'w-full',
          panelOpen ? 'flex flex-col md:flex-row md:gap-6' : 'block',
        ]"
        data-testid="ask-conversation-wrapper"
      >
        <div
          class="flex-1 min-w-0"
          data-testid="ask-conversation-column"
        >
          <div
            class="mx-auto w-full max-w-[860px] flex flex-col gap-6 pb-12"
          >
            <template v-for="(m, idx) in store.messages" :key="idx">
              <!-- User message -->
              <div
                v-if="m.role === 'user'"
                class="anim-rise-in self-end max-w-[88%] md:max-w-[70%] flex flex-col items-end gap-1.5 min-w-0"
                data-testid="user-message"
              >
                <div class="flex items-baseline gap-2 justify-end px-1">
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider">
                    Te
                  </span>
                </div>
                <div
                  class="bg-shell-message-user border border-shell-message-user-border
                         rounded-2xl rounded-tr-sm px-4 py-3
                         text-[14.5px] text-chat-read-text leading-relaxed shadow-sm
                         overflow-wrap-anywhere min-w-0"
                >
                  <SorszamLink :text="m.text" @sorszam-click="onSorszamClick" />
                </div>
              </div>

              <!-- Assistant: error bubble -->
              <div
                v-else-if="m.meta?.error"
                class="anim-rise-in self-start w-full flex flex-col items-start gap-1.5"
                data-testid="assistant-error"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                    NCT Szerviz Ai
                  </span>
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="w-full bg-danger/[0.08] border border-danger/25
                         rounded-2xl rounded-tl-sm px-5 py-4 text-[14px] text-danger"
                >
                  <div class="font-medium">
                    <SorszamLink :text="m.text" @sorszam-click="onSorszamClick" />
                  </div>
                  <div v-if="m.meta.error" class="text-xs opacity-80 mt-1">
                    {{ m.meta.error }}
                  </div>
                  <button
                    type="button"
                    class="mt-2.5 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md
                           bg-danger/15 border border-danger/25
                           text-[11.5px] font-medium text-danger
                           hover:bg-danger/25
                           transition-colors duration-150
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
                    data-testid="error-retry"
                    @click="retryFromError(idx)"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M2 8a6 6 0 0 1 10.2-4.2L14 2v4h-4l1.6-1.6A4.5 4.5 0 1 0 12.5 8"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    Újra próbálom
                  </button>
                </div>
              </div>

              <!-- Assistant: agentic answer -->
              <div
                v-else-if="m.meta?.agent"
                class="anim-rise-in self-start w-full min-w-0 flex flex-col items-start gap-1.5"
                data-testid="assistant-agent"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                    NCT Szerviz Ai
                  </span>
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="w-full min-w-0 bg-shell-message-assistant border border-shell-message-border
                         rounded-2xl rounded-tl-sm px-5 py-4 text-chat-read-text shadow-sm
                         overflow-wrap-anywhere"
                >
                  <AgentBody
                    :data="m.meta.agent"
                    @sorszam-click="onSorszamClick"
                  />
                  <!-- Context-aware follow-up chips (Phase 8, 2026-08-24,
                       A4 in the brainstorm). Tap a chip to fire a
                       follow-up question in the same thread. Hidden
                       while streaming. -->
                  <FollowUpChips
                    v-if="!typing"
                    :answer="m.meta.agent.final_text"
                    :answer-id="m.meta.agent.answer_id"
                    class="self-start"
                    data-testid="follow-up-chips-anchor"
                    @pick="submitQuestion"
                  />
                </div>
                <!-- Like / dislike footer + share button (Phase 8,
                     F4). Disabled while the agent is still streaming
                     a newer answer, but enabled on completed bubbles.
                     The share button copies /dashboard/v2/answer/<id>
                     to the clipboard. -->
                <div v-if="m.meta.agent.answer_id" class="w-full flex justify-end items-center gap-2 pr-1 -mt-1">
                  <button
                    type="button"
                    class="text-[11px] rounded px-1.5 py-0.5 inline-flex items-center gap-1 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
                    :class="copiedShareId === m.meta.agent.answer_id
                      ? 'text-success font-medium'
                      : 'text-text-muted hover:text-text-primary'"
                    :data-testid="`share-answer-${m.meta.agent.answer_id}`"
                    :data-copied="copiedShareId === m.meta.agent.answer_id ? 'true' : 'false'"
                    title="Hivatkozás másolása"
                    @click="onShareAnswer(m.meta.agent.answer_id)"
                  >
                    <!-- Copied state: checkmark instead of the share
                         glyph, label flips to "Kimásolva". -->
                    <svg
                      v-if="copiedShareId === m.meta.agent.answer_id"
                      width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"
                    >
                      <path d="M3 8.5l3.5 3.5L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <svg
                      v-else
                      width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"
                    >
                      <path
                        d="M10 5a2.5 2.5 0 1 1 1.5 2.3l-3.7 2.3a2.5 2.5 0 0 1 0 1l-3.7 2.3A2.5 2.5 0 1 1 3 11l3.7-2.3a2.5 2.5 0 0 1 0-1L3 5.4A2.5 2.5 0 1 1 4.5 4l3.7 2.3A2.5 2.5 0 0 1 10 5z"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <span>{{ copiedShareId === m.meta.agent.answer_id ? 'Kimásolva' : 'Megosztás' }}</span>
                  </button>
                  <AnswerVoteBar
                    :answer-id="m.meta.agent.answer_id"
                    :disabled="typing"
                    :initial-vote="myVotes.voteFor(m.meta.agent.answer_id)"
                    @vote-submitted="(p) => myVotes.castLocal(p.answerId, p.vote)"
                    @dislike-confirmed="onDislikeConfirmed"
                    @dislike-cleared="onDislikeCleared"
                  />
                </div>
                <!-- "Tudod a helyes választ? Küldd el a fejlesztésnek!"
                     link — appears below the bubble only after the
                     user has disliked THIS answer in this session.
                     Anchored to the right to mirror the vote bar
                     placement, separated from it by a small gap. -->
                <div
                  v-if="dislikedIds.has(m.meta.agent.answer_id)"
                  class="w-full flex justify-end pr-1 mt-1"
                  :data-testid="`send-correct-answer-row-${m.meta.agent.answer_id}`"
                >
                  <!-- NOT YET SENT — clickable, opens CorrectionModal.
                       Mirrors the legacy branch below. -->
                  <button
                    v-if="!myCorrections.correctionFor(m.meta.agent.answer_id)"
                    type="button"
                    class="text-[11.5px] text-text-muted hover:text-nct-soft
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
                           rounded px-1.5 py-0.5"
                    :data-testid="`send-correct-answer-${m.meta.agent.answer_id}`"
                    @click="openCorrection(m.meta.agent.answer_id)"
                  >
                    Tudod a helyes választ?
                    <span class="text-nct-soft underline underline-offset-2 font-medium">
                      Küldd el
                    </span>
                    a fejlesztésnek!
                  </button>
                  <!-- ALREADY SENT — non-interactive confirmation. The
                       ✓-glyph plus nct-soft color telegraphs the
                       "feedback recorded" state. The text stays as a
                       clickable hint that the user can refine the
                       correction (re-opens the modal pre-filled with
                       the last value, see CorrectionModal). -->
                  <button
                    v-else
                    type="button"
                    class="text-[11.5px] text-text-muted cursor-pointer
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
                           rounded px-1.5 py-0.5"
                    :data-testid="`send-correct-answer-sent-${m.meta.agent.answer_id}`"
                    :aria-label="`Visszajelzés elküldve (${m.meta.agent.answer_id})`"
                    @click="openCorrection(m.meta.agent.answer_id)"
                  >
                    Visszajelzés elküldve
                    <span class="text-nct-soft font-medium" aria-hidden="true">✓</span>
                  </button>
                </div>
              </div>

              <!-- Assistant: legacy deterministic answer -->
              <div
                v-else-if="m.meta?.answer"
                class="anim-rise-in self-start w-full min-w-0 flex flex-col items-start gap-1.5"
                data-testid="assistant-answer"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                    NCT Szerviz Ai
                  </span>
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="w-full min-w-0 bg-shell-message-assistant border border-shell-message-border
                         rounded-2xl rounded-tl-sm px-5 py-4 text-chat-read-text shadow-sm
                         overflow-wrap-anywhere"
                >
                  <AnswerBody
                    :data="m.meta.answer"
                    @run="runConfirmed"
                    @refine="refineQuestion"
                    @followup="submitQuestion"
                    @sorszam-click="onSorszamClick"
                  />
                </div>
                <!-- Like / dislike footer. The legacy /v1/answer
                     endpoint now stamps an answer_id and inserts a
                     feedback_answers row, so the bar is wired the
                     same way as the agent path. -->
                <div v-if="m.meta.answer.answer_id" class="w-full flex justify-end pr-1 -mt-1">
                  <AnswerVoteBar
                    :answer-id="m.meta.answer.answer_id"
                    :disabled="typing"
                    :initial-vote="myVotes.voteFor(m.meta.answer.answer_id)"
                    @vote-submitted="(p) => myVotes.castLocal(p.answerId, p.vote)"
                    @dislike-confirmed="onDislikeConfirmed"
                    @dislike-cleared="onDislikeCleared"
                  />
                </div>
                <!-- "Tudod a helyes választ? Küldd el a fejlesztésnek!"
                     link — same flow as the agent branch. -->
                <div
                  v-if="dislikedIds.has(m.meta.answer.answer_id)"
                  class="w-full flex justify-end pr-1 mt-1"
                  :data-testid="`send-correct-answer-row-${m.meta.answer.answer_id}`"
                >
                  <button
                    v-if="!myCorrections.correctionFor(m.meta.answer.answer_id)"
                    type="button"
                    class="text-[11.5px] text-text-muted hover:text-nct-soft
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
                           rounded px-1.5 py-0.5"
                    :data-testid="`send-correct-answer-${m.meta.answer.answer_id}`"
                    @click="openCorrection(m.meta.answer.answer_id)"
                  >
                    Tudod a helyes választ?
                    <span class="text-nct-soft underline underline-offset-2 font-medium">
                      Küldd el
                    </span>
                    a fejlesztésnek!
                  </button>
                  <button
                    v-else
                    type="button"
                    class="text-[11.5px] text-text-muted cursor-pointer
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40
                           rounded px-1.5 py-0.5"
                    :data-testid="`send-correct-answer-sent-${m.meta.answer.answer_id}`"
                    :aria-label="`Visszajelzés elküldve (${m.meta.answer.answer_id})`"
                    @click="openCorrection(m.meta.answer.answer_id)"
                  >
                    Visszajelzés elküldve
                    <span class="text-nct-soft font-medium" aria-hidden="true">✓</span>
                  </button>
                </div>

                <div
                  v-if="evidenceFor(m.meta.answer).length > 0"
                  class="w-full mt-2 flex gap-2 overflow-x-auto px-1 pb-1 snap-x"
                  data-testid="evidence-card-row"
                >
                  <button
                    v-for="t in evidenceFor(m.meta.answer)"
                    :key="t.sorszam"
                    type="button"
                    class="snap-start shrink-0 w-60 text-left
                           bg-shell-message-assistant hover:bg-shell-rail-hover
                           border border-shell-message-border hover:border-nct-soft/40
                           rounded-lg px-3 py-2.5
                           transition-colors duration-150
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
                    :aria-label="`Ticket ${t.sorszam} részletei`"
                    :data-testid="`evidence-ticket-${t.sorszam}`"
                    @click="openTicket(t)"
                  >
                    <div class="font-mono text-[11px] text-nct-soft font-medium">{{ t.sorszam }}</div>
                    <p class="mt-1 text-[12px] text-chat-read-muted line-clamp-2 leading-snug">
                      <SorszamLink :text="t.snippet" @sorszam-click="onSorszamClick" />
                    </p>
                    <div
                      v-if="t.kategoria"
                      class="mt-1.5 text-[10px] font-mono uppercase tracking-wider text-chat-read-muted"
                    >
                      {{ t.kategoria }}
                    </div>
                  </button>
                </div>
              </div>

              <!-- Legacy compatibility: a `role: 'correction'`
                   message persisted in an older thread. New
                   corrections are NOT appended to the thread (the
                   inline "Visszajelzés elküldve ✓" state under the
                   source bubble is enough). For old threads we
                   render a small, right-aligned meta-line so the
                   user can still see that the correction was
                   sent — without faking an AI reply. -->
              <div
                v-else-if="m.role === 'correction' && m.meta?.correction"
                class="self-end max-w-[88%] md:max-w-[70%] flex flex-col items-end gap-0.5 min-w-0"
                :data-testid="`correction-message-${m.meta.correction.answer_id}`"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="font-mono text-[10px] text-text-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                  <span class="text-[10px] font-medium text-nct-soft uppercase tracking-wider font-mono">
                    Helyes válasz · elküldve
                    <span aria-hidden="true">✓</span>
                  </span>
                </div>
                <div
                  class="bg-nct-soft/[0.05] border border-nct-soft/15
                         rounded-2xl rounded-tr-sm px-3 py-2
                         text-[13px] text-text-secondary leading-relaxed
                         overflow-wrap-anywhere min-w-0"
                  :data-testid="`correction-bubble-${m.meta.correction.answer_id}`"
                >
                  {{ m.text }}
                </div>
              </div>
            </template>

            <!-- Inline transport / non-answer error -->
            <div
              v-if="errorText"
              class="self-start bg-danger/[0.08] border border-danger/25 rounded-lg px-4 py-3 text-[13px] text-danger flex items-center justify-between gap-3 w-full"
              data-testid="inline-error"
            >
              <span>{{ errorText }}</span>
              <Button
                variant="secondary"
                size="sm"
                data-testid="inline-error-retry"
                @click="retryLast"
              >
                Újra
              </Button>
            </div>

            <!-- Typing indicator — pre-stream / pre-flight only. While
                 the SSE stream is active the live streaming bubble below
                 takes over (progressive disclosure, feature #1). -->
            <div
              v-if="typing && !streamingActive"
              class="anim-rise-in self-start w-full flex flex-col items-start gap-1.5"
              data-testid="agent-thinking"
            >
              <div class="flex items-baseline gap-2 px-1">
                <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                  NCT Szerviz Ai
                </span>
              </div>
              <div
                class="bg-shell-message-assistant border border-shell-message-border
                       rounded-2xl rounded-tl-sm px-5 py-3.5 flex items-center gap-2.5 shadow-sm"
              >
                <svg
                  class="w-4 h-4 text-nct-soft animate-nct-pulse-glow"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                  data-testid="agent-thinking-icon"
                >
                  <path
                    d="M12 2.5l2.2 5.9 5.9 2.2-5.9 2.2L12 18.7l-2.2-5.9-5.9-2.2 5.9-2.2L12 2.5z"
                  />
                </svg>
                <span class="text-[13px] text-chat-read-muted font-medium">
                  Gondolkodom…<template v-if="waitSeconds >= 3">&nbsp;({{ waitSeconds }}s)</template>
                </span>
                <div class="flex items-center gap-1 ml-1">
                  <span class="w-1 h-1 rounded-full bg-nct-soft animate-nct-blink" style="animation-delay: 0ms" />
                  <span class="w-1 h-1 rounded-full bg-nct-soft animate-nct-blink" style="animation-delay: 150ms" />
                  <span class="w-1 h-1 rounded-full bg-nct-soft animate-nct-blink" style="animation-delay: 300ms" />
                </div>
              </div>
            </div>

            <!-- Live streaming bubble — progressive disclosure
                 (feature #1): while the SSE stream is open the operator
                 sees the tool calls being made (spinner → ✓/✗) and the
                 final answer being typed token-by-token (feature #2).
                 Replaces the static "Gondolkodom…" indicator once the
                 first frame arrives. The phase label lives ONLY next
                 to the shine icon inside the bubble (2026-08-25: it
                 was duplicated next to the name too). -->
            <div
              v-if="streamingActive"
              class="anim-rise-in self-start w-full min-w-0 flex flex-col items-start gap-1.5"
              data-testid="assistant-streaming"
            >
              <div class="flex items-baseline gap-2 px-1">
                <span class="nct-live-name text-[10px] font-medium uppercase tracking-wider font-mono">
                  NCT Szerviz Ai
                </span>
              </div>
              <div
                class="nct-live-glow relative w-full min-w-0 bg-shell-message-assistant border border-shell-message-border
                       rounded-2xl rounded-tl-sm px-5 py-4 text-chat-read-text shadow-sm
                       overflow-wrap-anywhere"
              >
                <!-- Activity ribbon across the top edge while live. -->
                <div class="nct-stream-ribbon" aria-hidden="true" data-testid="streaming-ribbon" />
                <!-- Tool trace -->
                <div
                  v-if="streamingTools.length > 0"
                  class="flex flex-wrap gap-1.5 mb-3"
                  data-testid="streaming-tools"
                >
                  <span
                    v-for="(t, ti) in streamingTools"
                    :key="t.id"
                    class="anim-rise-in inline-flex items-center gap-1.5 h-6 px-2 rounded-md
                           bg-shell-rail-elevated border border-shell-rail-border
                           font-mono text-[10.5px] text-chat-read-muted"
                    :class="t.ok ? 'streaming-tool-ok' : ''"
                    :style="{ animationDelay: `${Math.min(ti * 45, 270)}ms` }"
                    :data-testid="`streaming-tool-${t.name}`"
                  >
                    <span
                      v-if="t.ok === undefined"
                      class="w-2.5 h-2.5 rounded-full border-[1.5px] border-current border-t-transparent animate-spin"
                      aria-hidden="true"
                    />
                    <svg
                      v-else-if="t.ok"
                      width="10" height="10" viewBox="0 0 12 12" fill="none"
                      class="text-emerald-400" aria-hidden="true"
                    >
                      <path d="M2 6.2L4.6 8.8 10 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <svg
                      v-else
                      width="10" height="10" viewBox="0 0 12 12" fill="none"
                      class="text-danger" aria-hidden="true"
                    >
                      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    </svg>
                    <span class="font-medium">{{ t.name }}</span>
                  </span>
                </div>

                <!-- Streamed final-answer text -->
                <div
                  v-if="streamingText.length > 0"
                  class="text-[14.5px] leading-relaxed whitespace-pre-wrap"
                  data-testid="streaming-text"
                >
                  {{ streamingText }}
                  <span
                    class="inline-block w-1.5 h-3.5 ml-0.5 align-text-bottom rounded-[1px] bg-nct-soft animate-nct-blink"
                    aria-hidden="true"
                  />
                </div>

                <!-- No text yet — pulsing icon + phase hint + skeleton
                     lines. Phase 8, 2026-08-24 (D7): replace the bare
                     "Dolgozom…" with three shimmering lines so the
                     user perceives content *being assembled* instead
                     of an empty bubble. The lines are content-shaped
                     (not the same width — first line wider to look like
                     a paragraph) and disappear the moment the first
                     real token arrives. -->
                <div
                  v-else
                  class="space-y-2 py-1"
                  data-testid="streaming-waiting"
                >
                  <div class="flex items-center gap-2.5">
                    <svg
                      class="w-4 h-4 text-nct-soft animate-nct-pulse-glow"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 2.5l2.2 5.9 5.9 2.2-5.9 2.2L12 18.7l-2.2-5.9-5.9-2.2 5.9-2.2L12 2.5z"
                      />
                    </svg>
                    <span class="text-[13px] text-chat-read-muted font-medium">
                      {{ phaseLabel }}
                    </span>
                    <!-- Mild elapsed milestone (Pack 2, subtle): only
                         after 5s so short answers stay clean. -->
                    <span
                      v-if="waitSeconds >= 5"
                      class="font-mono text-[10px] text-chat-read-muted tabular-nums"
                      data-testid="streaming-elapsed"
                    >
                      · {{ waitSeconds }} mp
                    </span>
                  </div>
                  <div class="space-y-1.5">
                    <Skeleton h="h-3" w="w-[88%]" />
                    <Skeleton h="h-3" w="w-[72%]" />
                    <Skeleton h="h-3" w="w-[58%]" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- In-place right column (desktop only).
             On mobile, ticket details go through the teleported
             TicketInspector overlay instead. -->
        <TicketPanel
          v-if="panelOpen && !isMobile"
          :open="panelOpen"
          :ticket="panelTicket"
          class="md:w-[420px] shrink-0 md:self-start"
          @update:open="closePanel"
          @open-in-ask="onTicketOpenInAsk"
        />
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- "Jump to latest" pill (when user scrolled away from bottom)  -->
    <!-- ============================================================ -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="opacity-0 translate-y-2"
      leave-to-class="opacity-0 translate-y-2"
    >
      <button
        v-if="!userAtBottom && store.messages.length > 0 && !isMobile"
        type="button"
        class="absolute bottom-24 left-1/2 -translate-x-1/2 z-20
               inline-flex items-center gap-1.5 h-8 px-3.5
               bg-surface border border-border-default
               rounded-full shadow-lg shadow-black/20
               text-[12px] font-medium text-text-primary
               hover:bg-surface-2 hover:border-border-strong
               focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
               transition-colors duration-150"
        data-testid="ask-jump-latest"
        @click="jumpToLatest"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3v9M4 9l4 4 4-4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>Ugrás a legújabbhoz</span>
      </button>
    </Transition>

    <!-- ============================================================ -->
    <!-- Docked-bottom composer (ONLY when conversation is active)   -->
    <!-- On mobile the bottom tab bar (BottomTabs, h-14 + safe-area) -->
    <!-- is `fixed bottom-0 z-40` and would otherwise slide under or  -->
    <!-- cover the composer. We lift the composer above it with a     -->
    <!-- matching bottom margin. On `md+` the BottomTabs is `hidden`  -->
    <!-- so this margin is removed.                                   -->
    <!-- ============================================================ -->
    <div
      v-if="store.messages.length > 0"
      class="shrink-0 relative z-10 px-3 md:px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:pt-3 md:pb-3 mb-[calc(4rem+env(safe-area-inset-bottom))] md:mb-0"
      data-testid="ask-composer"
    >
      <div
        class="mx-auto w-full max-w-[860px]"
        :class="panelOpen ? 'md:max-w-[calc(100vw-460px)]' : ''"
      >
        <div class="flex items-center gap-2 mb-1.5">
          <MachineScopeBar />
          <div class="flex-1 md:hidden">
            <AskThreadBar />
          </div>
        </div>
        <AskBar
          v-model="q"
          :size="composerSize"
          rounded="lg"
          input-id="ask-input"
          placeholder="Kérdezd a NCT Szerviz Ai-t…"
          :disabled="typing"
          :busy="typing"
          :mic="voiceSupported"
          :mic-listening="voiceListening"
          :mic-hands-free-hint="true"
          @submit="submitQuestion"
          @mic-toggle="onMicToggle"
          @mic-handsfree="onMicHandsFree"
        />
      </div>
    </div>

    <!-- Ticket inspector (right-drawer on desktop, bottom sheet on mobile) -->
    <TicketInspector
      :open="inspectorOpen"
      :ticket="inspectorTicket"
      @update:open="closeInspector"
      @open-in-ask="onTicketOpenInAsk"
    />

    <!-- "Helyes válasz elküldése" modal — opened from the inline
         "Küldd el a fejlesztésnek!" link below a disliked answer.
         Lives at the very end of the template so it overlays
         everything (highest in the stacking order is set by the
         modal's own fixed/z-50 styles). -->
    <CorrectionModal
      :open="correctionFor !== null"
      :answer-id="correctionFor ?? ''"
      :busy="correctionBusy"
      @update:open="closeCorrection"
      @submitted="submitCorrection"
    />

    <!-- Hands-free voice dictation bottom sheet (mobile-first, 2026-08-24).
         Teleport inside the component puts the DOM at <body>, so the
         sheet sits above every route. Triggered by long-pressing the
         AskBar mic, or by the "Kéz használata nélkül" chip below. -->
    <VoiceDictationSheet
      v-model:open="handsFreeOpen"
      @submit="onHandsFreeSubmit"
    />
    <!-- Photo-to-ask sheet (Phase 8, 2026-08-24, A7+B7). The
         submit event delivers a pre-filled question; we route it
         through the normal submitQuestion path so the same
         machine-scope, streaming, and chat-thread logic applies. -->
    <PhotoAskSheet
      v-model:open="photoAskOpen"
      @submit="submitQuestion"
      @dictate="onPhotoDictate"
    />
  </div>
</template>
