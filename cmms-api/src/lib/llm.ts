// src/lib/llm.ts
//
// LLM client for the pure-RAG endpoint. The LLM is the rephraser
// only — it never picks a tool, never queries a DB, never invents
// facts. We hand it:
//
//   1. The user's question (verbatim)
//   2. The retrieved chunks (the only source of truth)
//   3. A short system prompt that says "answer using ONLY the
//      chunks, cite sorszams, be concise, write in the user's
//      language"
//
// We then run the output through enforceGrounding() and reject
// anything that introduces a sorszam / customer / date not in the
// chunks.
//
// Transport: Kilo Gateway (OpenAI-compatible) at
//   https://api.kilo.ai/api/gateway
// Auth:      env KILO_API_KEY
// Model:     env KILO_MODEL  (default: openai/gpt-5.6-luna-pro)
//
// Non-streaming only at the moment — the OpenAI-compat endpoint in
// routes/answer.ts is responsible for tokenizing the LLM output
// into SSE frames.

export type RenderInput = {
  question: string;
  language: "hu" | "en";
  chunks: Array<{
    sorszam: string;
    customer: string | null;
    device: string | null;
    reported_at_iso: string | null;
    kategoria: string | null;
    top_chunks: Array<{ kind: string; body: string; score: number }>;
  }>;
};

export type RenderResult = {
  text: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number;
};

export function llmConfigured(): boolean {
  return !!process.env.KILO_API_KEY && process.env.KILO_API_KEY.length > 0;
}

export async function renderLlmAnswer(input: RenderInput): Promise<RenderResult | null> {
  if (!llmConfigured()) return null;
  const apiKey = process.env.KILO_API_KEY!;
  const baseUrl = process.env.KILO_BASE_URL ?? "https://api.kilo.ai/api/gateway";
  const model = process.env.KILO_MODEL ?? "openai/gpt-5.6-luna-pro";

  const t0 = Date.now();

  // Build the messages. Two system turns (one for general
  // behavior, one for the language hint + format), one user turn
  // with the question + chunks.
  const sys = input.language === "hu"
    ? "Te egy NCT szerviz asszisztens vagy. Válaszolj KIZÁRÓLAG a kapott CMSS jegy-részletek alapján. " +
        "Ne találj ki sorszámot, ügyfélnevet vagy dátumot. Ha a jegyek nem fedik a kérdést, mondd: " +
        "\"A megadott jegyek között nincs erre válasz.\" Röviden, lényegre törően válaszolj, " +
        "magyarul. Az egyes jegyekre hivatkozz sorszámukkal (pl. B2408001)."
    : "You are an NCT service desk assistant. Answer ONLY based on the provided CMSS ticket chunks. " +
        "Never invent a sorszam, customer name, or date. If the chunks do not cover the question, " +
        "say: \"The provided tickets do not answer this.\" Be concise, English. " +
        "Reference tickets by sorszam (e.g. B2408001).";

  const userPayload = JSON.stringify({
    question: input.question,
    chunks: input.chunks,
  });

  const body = {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userPayload },
    ],
    temperature: 0.2,
    max_tokens: 800,
    // We do NOT pass stream:true here — the routes/answer.ts
    // tokenizes the LLM output into SSE frames itself. Streaming
    // from the gateway would complicate the grounding gate.
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      msg: "llm_http_error",
      status: res.status,
      body: (await res.text()).slice(0, 500),
    }));
    return null;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") return null;

  return {
    text: text.trim(),
    model: data?.model ?? model,
    prompt_tokens: data?.usage?.prompt_tokens ?? null,
    completion_tokens: data?.usage?.completion_tokens ?? null,
    duration_ms: Date.now() - t0,
  };
}
