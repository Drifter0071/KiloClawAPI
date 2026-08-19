// src/composables/useAgentStream.ts
//
// SSE consumer for POST /dashboard/api/answer-agent/stream.
//
// The dashboard proxy forwards cmms-api's `text/event-stream` byte
// stream untouched, so this composable does the raw framing: split on
// blank lines, parse `event:` / `data:` fields, JSON-parse the data,
// and dispatch to the caller's handlers.
//
// Contract:
//   - resolves with the full AnswerAgentResponse when an `answer`
//     event arrives (the terminal frame of a successful run);
//   - throws AgentStreamFailedError when an `error` event arrives
//     (definitive agent failure — hard-fail contract, the caller shows
//     it, it does NOT retry);
//   - throws StreamEndedWithoutAnswerError on EOF without an `answer`
//     (transport truncation / proxy cut) so the caller can fall back
//     to the async-poll flow.

import type {
  AnswerAgentResponse,
  AgentStreamEvent,
} from '@/lib/api'

/** Thrown when the server sends `event: error` (agent_failed /
 *  internal). Carries the wire code + message. */
export class AgentStreamFailedError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentStreamFailedError'
    this.code = code
  }
}

/** Thrown when the stream ended without an `answer` frame. */
export class StreamEndedWithoutAnswerError extends Error {
  constructor() {
    super('The answer stream ended without a final answer.')
    this.name = 'StreamEndedWithoutAnswerError'
  }
}

export interface AgentStreamHandlers {
  onStatus?: (phase: 'start' | 'searching' | 'synthesizing' | 'soft_deadline') => void
  onToolStart?: (name: string, args: Record<string, unknown>) => void
  onToolDone?: (name: string, ok: boolean, note: string | undefined, summary: string | undefined) => void
  onToken?: (text: string) => void
  /** Optional: every parsed event (debugging / advanced UI). */
  onEvent?: (ev: AgentStreamEvent) => void
}

/** Parses one SSE frame (`event:` + `data:` lines) into an event. */
function parseFrame(frame: string): { event: string; data: string } | null {
  if (frame.length === 0) return null
  let event = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

/**
 * Consumes the SSE response body until the terminal `answer` frame.
 *
 * @param res  the raw fetch Response (content-type text/event-stream)
 * @param handlers  callbacks for status / tool / token progress
 * @returns the final AnswerAgentResponse
 */
export async function consumeAgentStream(
  res: Response,
  handlers: AgentStreamHandlers = {},
): Promise<AnswerAgentResponse> {
  if (!res.body) throw new StreamEndedWithoutAnswerError()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let terminalOutcome: AnswerAgentResponse | null = null

  const handleFrame = (frame: string): boolean => {
    const parsed = parseFrame(frame)
    if (!parsed) return false
    let payload: unknown
    try {
      payload = JSON.parse(parsed.data)
    } catch {
      return false // malformed — skip
    }
    const obj = payload as Record<string, unknown> | null
    switch (parsed.event) {
      case 'status': {
        const phase = obj?.phase as 'start' | 'searching' | 'synthesizing' | 'soft_deadline'
        if (phase) handlers.onStatus?.(phase)
        break
      }
      case 'tool_start':
        handlers.onToolStart?.(
          String(obj?.name ?? ''),
          (obj?.args as Record<string, unknown> | undefined) ?? {},
        )
        break
      case 'tool_done':
        handlers.onToolDone?.(
          String(obj?.name ?? ''),
          obj?.ok === true,
          typeof obj?.note === 'string' ? obj.note : undefined,
          typeof obj?.summary === 'string' ? obj.summary : undefined,
        )
        break
      case 'token': {
        const text = typeof obj?.text === 'string' ? obj.text : ''
        if (text.length > 0) handlers.onToken?.(text)
        break
      }
      case 'answer': {
        terminalOutcome = obj as unknown as AnswerAgentResponse
        handlers.onEvent?.({ type: 'answer', outcome: terminalOutcome })
        return true // terminal
      }
      case 'error': {
        const code = String(obj?.code ?? 'agent_failed')
        const message = String(obj?.message ?? 'A válasz elkészítése meghiúsult.')
        throw new AgentStreamFailedError(code, message)
      }
      default:
        break
    }
    handlers.onEvent?.(payload as AgentStreamEvent)
    return false
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep = buffer.indexOf('\n\n')
    while (sep >= 0) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const terminal = handleFrame(frame)
      if (terminal) {
        // Drain the reader so the connection is cleanly reusable, but
        // do not wait for the server's final bytes if it never sends
        // them (some proxies truncate).
        reader.cancel().catch(() => {})
        return terminalOutcome!
      }
      sep = buffer.indexOf('\n\n')
    }
  }
  if (buffer.length > 0) {
    const terminal = handleFrame(buffer)
    if (terminal) return terminalOutcome!
  }

  throw new StreamEndedWithoutAnswerError()
}
