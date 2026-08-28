// /v1/chat/completions — the single RAG endpoint.
//
// OpenAI-compatible shape:
//   POST {model, messages, stream?, use_llm?, top_k?}
//   -> {choices:[{message:{content}}], cmms:{...}}
//   or SSE frames `data: {choices:[{delta:{content:...}}]}\n\n`
//
// Pipeline:
//   1. Pull the last user message as the question.
//   2. Detect language (Hungarian diacritics => hu, else en).
//   3. FTS5 search over rag_chunks -> top-K chunks (default 20).
//   4. Group chunks by sorszam -> top 3 chunks per ticket.
//   5. Build a deterministic "evidence-only" fallback answer that
//      lists the matched tickets with their sorszam, customer,
//      device, date, and the first 200 chars of the top chunk.
//   6. If Kilo is configured, call renderLlmAnswer() to rephrase.
//   7. Run the LLM output through enforceGrounding() — reject
//      anything that invents a sorszam, customer, or date.
//   8. Ship the OpenAI response, with a `cmms:` extension payload
//      that exposes the intent, chunks, and grounding verdict.

import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { OpenDbs } from "../db/open";
import type { RagIndex, RagHit } from "../lib/rag";
import { ragSearch, groupHits } from "../lib/rag";
import { renderLlmAnswer, llmConfigured } from "../lib/llm";
import { enforceGrounding } from "../lib/grounding";

// Crockford-base32 ULID. Inline so this file has no other
// dependencies.
const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function newUlid(): string {
  const now = Date.now();
  let ts = now;
  let tsPart = "";
  for (let i = 9; i >= 0; i -= 1) {
    tsPart = ULID_ALPHABET[ts % 32] + tsPart;
    ts = Math.floor(ts / 32);
  }
  let randPart = "";
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i] ?? 0;
    randPart += ULID_ALPHABET[byte % 32];
  }
  return tsPart + randPart;
}

type ChatBody = {
  model?: string;
  messages?: Array<{ role: string; content: string | null | Array<any> }>;
  stream?: boolean;
  temperature?: number;
  use_llm?: boolean;
  top_k?: number;
};

export function answerRouter(dbs: OpenDbs, rag: RagIndex): Router {
  const r = makeRouter();

  r.post("/completions", async (req, res) => {
    const body = (req.body ?? {}) as ChatBody;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    const rawContent = lastUser?.content;
    const q =
      typeof rawContent === "string"
        ? rawContent.trim()
        : Array.isArray(rawContent)
          ? rawContent
              .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
              .join(" ")
              .trim()
          : "";
    if (!q) {
      res.status(400).json({
        error: {
          message:
            "'messages' must contain a user message with non-empty content.",
          type: "invalid_request_error",
          param: "messages",
        },
      });
      return;
    }
    const stream = body.stream === true;
    const model =
      typeof body.model === "string" && body.model.length > 0
        ? body.model
        : "cmms";
    const language: "hu" | "en" = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(q) ? "hu" : "en";
    const topK = Math.max(1, Math.min(50, body.top_k ?? 20));
    const useLlm = body.use_llm !== false;

    // 1) Retrieve.
    const chunks = ragSearch(dbs, q, { limit: topK });
    const hits = groupHits(chunks);

    // 2) Build deterministic fallback.
    const fallback = buildFallback(q, hits, language);

    // 3) Optional LLM rewrite + grounding gate.
    let finalText = fallback;
    let usedLlm = false;
    let groundingVerdict: ReturnType<typeof enforceGrounding> | null = null;
    let llmMeta: { model: string; duration_ms: number } | null = null;

    if (useLlm && llmConfigured() && hits.length > 0) {
      try {
        const rendered = await renderLlmAnswer({
          question: q,
          language,
          chunks: hits.map((h) => ({
            sorszam: h.sorszam,
            customer: h.customer,
            device: h.device,
            reported_at_iso: h.reported_at_iso,
            kategoria: h.kategoria,
            top_chunks: h.top_chunks,
          })),
        });
        if (rendered) {
          llmMeta = { model: rendered.model, duration_ms: rendered.duration_ms };
          groundingVerdict = enforceGrounding(rendered.text, hits, fallback);
          if (groundingVerdict.ok) {
            finalText = rendered.text;
            usedLlm = true;
          } else {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({
              t: new Date().toISOString(),
              msg: "grounding_rejected",
              endpoint: "/v1/chat/completions",
              rejected: groundingVerdict.rejected_facts,
              scanned: groundingVerdict.scanned,
              q_preview: q.slice(0, 80),
            }));
            // finalText stays = fallback.
          }
        }
      } catch (e) {
        // Never 500. finalText stays = fallback.
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({
          t: new Date().toISOString(),
          msg: "llm_call_failed",
          error: String((e as Error)?.message ?? e),
          q_preview: q.slice(0, 80),
        }));
      }
    }

    // 4) CMMS extension payload (always).
    const cmms = {
      mode: "pure-rag",
      language,
      question: q,
      hits_count: hits.length,
      chunks_count: chunks.length,
      used_llm: usedLlm,
      llm: llmMeta,
      grounding: groundingVerdict
        ? {
            ok: groundingVerdict.ok,
            scanned: groundingVerdict.scanned,
            rejected: groundingVerdict.rejected_facts,
          }
        : null,
      top_hits: hits.slice(0, 5).map((h) => ({
        sorszam: h.sorszam,
        customer: h.customer,
        device: h.device,
        reported_at_iso: h.reported_at_iso,
        kategoria: h.kategoria,
        status: h.status,
        top_chunks: h.top_chunks.map((c) => ({ kind: c.kind, body: c.body.slice(0, 240) })),
      })),
    };

    // 5) OpenAI-shaped response.
    const completionId = `chatcmpl-${newUlid()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: finalText },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: q.length, // crude
          completion_tokens: finalText.length, // crude
          total_tokens: q.length + finalText.length,
        },
        cmms,
      });
      return;
    }

    // Streaming SSE. Same shape as the OpenAI chat.completion.chunk
    // frames; Lobe Chat / Open WebUI / LibreChat all consume this.
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const enc = new TextEncoder();
    const send = (obj: unknown) => {
      if (res.writableEnded) return;
      res.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    };

    // role frame
    send({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    // content frames — ~12 tokens per frame, 25ms apart so the
    // SSE typing effect is visible in the UI.
    const tokens = finalText.match(/\S+\s*|\s+/g) ?? [finalText];
    const CHUNK = 12;
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const piece = tokens.slice(i, i + CHUNK).join("");
      send({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 25);
        res.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (res.writableEnded) return;
    }

    // final + DONE
    send({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    res.write(enc.encode("data: [DONE]\n\n"));
    res.end();
  });

  return r;
}

// ---------------------------------------------------------------------------
// Deterministic fallback builder. No LLM. Just the matched tickets.
// ---------------------------------------------------------------------------

function buildFallback(q: string, hits: RagHit[], language: "hu" | "en"): string {
  if (hits.length === 0) {
    return language === "hu"
      ? `A keresés (\u201c${q}\u201d) nem talált a jegyek között. Próbáld meg más szavakkal vagy sorszámmal (pl. B2408001).`
      : `No tickets matched the query \u201c${q}\u201d. Try different keywords or a sorszam (e.g. B2408001).`;
  }

  const lines: string[] = [];
  lines.push(
    language === "hu"
      ? `${hits.length} jegy illeszkedik a keresésre:`
      : `${hits.length} ticket(s) matched the query:`,
  );
  for (const h of hits.slice(0, 10)) {
    const date = h.reported_at_iso ? h.reported_at_iso.slice(0, 10) : "?";
    const cust = h.customer ?? "?";
    const dev = h.device ?? "?";
    const top = h.top_chunks[0];
    const snippet = top ? top.body.slice(0, 180).replace(/\s+/g, " ").trim() : "";
    lines.push(
      `- **${h.sorszam}** (${date}) — ${cust} — ${dev}` +
        (h.kategoria ? ` [${h.kategoria}]` : "") +
        (snippet ? `\n  > ${snippet}${snippet.length === 180 ? "\u2026" : ""}` : ""),
    );
  }
  if (hits.length > 10) {
    lines.push(
      language === "hu"
        ? `…és még ${hits.length - 10} jegy.`
        : `…and ${hits.length - 10} more.`,
    );
  }
  return lines.join("\n");
}
