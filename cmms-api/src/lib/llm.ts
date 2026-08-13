// src/lib/llm.ts
//
// Render-only LLM wrapper (Kilo Gateway, OpenAI-compatible
// chat/completions). The LLM NEVER picks tools and NEVER builds the
// answer from scratch — it only rewrites the deterministic `summary`
// into natural, human-readable prose. The deterministic path stays the
// source of truth (this is what fixes the old ~65% reproducibility
// problem); the LLM is a presentation layer on top.
//
// Every failure path returns null and the caller falls back to the
// deterministic summary, so a key rotation, network blip, timeout, or
// model outage never degrades the answer path.

export const LLM_TIMEOUT_MS = 20_000;
export const LLM_DEFAULT_MODEL = "kilocode/openai/gpt-4o";
export const LLM_DEFAULT_BASE_URL = "https://api.kilo.ai/api/gateway";

/** True when a Kilo API key is present in the server env. */
export function llmConfigured(): boolean {
  return !!((process.env.KILO_API_KEY ?? "").trim());
}

export function llmModel(): string {
  return (process.env.KILO_MODEL ?? "").trim() || LLM_DEFAULT_MODEL;
}

export function llmBaseUrl(): string {
  return (process.env.KILO_BASE_URL ?? "").trim() || LLM_DEFAULT_BASE_URL;
}

export type RenderLlmArgs = {
  question: string;
  language: "hu" | "en";
  summary: string;
  mode: "answer" | "confirm";
  /** Top candidates' summaries so the LLM can phrase the ambiguity. */
  candidates: Array<{ intent: string; score: number; summary: string }>;
  periodLabel?: string | null;
};

const SYSTEM_PROMPTS: Record<"hu" | "en", string> = {
  hu: `Gépszerviz jelentés-asszisztens vagy egy ipari CNC vezérlőket gyártó és szervizelő cégnél.
Egy szabályalapú motor determinisztikus válaszát írod át természetes, emberi, műhelyvezetőnek olvasható magyar szöveggé.

Szabályok:
- SOHA ne találj ki tényt. Minden sorszámot, sorozatszámot, ügyfélnevet, dátumot, darabszámot és számadatot pontosan úgy tarts meg, ahogy a bemenetben szerepel.
- Ne adj hozzá tanácsot, árat, garanciát vagy spekulációt.
- Ha a válasz megerősítő kérdés (mode=confirm), maradjon rövid, kérdező mondat.
- Csak az átírt választ küldd vissza, előszó és utószó nélkül.`,
  en: `You are a service-report assistant for an industrial CNC controller repair company.
You rewrite a deterministic rule-engine answer into natural, human-readable English for a workshop manager.

Rules:
- NEVER invent facts. Keep every work-order id (sorszam), serial number, customer name, date, and count exactly as given.
- Do not add advice, pricing, warranty, or speculation.
- If the answer is a confirmation question (mode=confirm), keep it a short question.
- Reply with only the rewritten answer, no preamble.`,
};

function buildUserPrompt(a: RenderLlmArgs): string {
  const period = a.periodLabel ? a.periodLabel : "—";
  const alternates =
    a.candidates.length > 0
      ? a.candidates
          .map(
            (c, i) =>
              `${i + 1}. ${c.intent} (${(c.score * 100).toFixed(0)}%): ${c.summary}`,
          )
          .join("\n")
      : "—";
  if (a.language === "hu") {
    return (
      `Kérdés: ${a.question}\n` +
      `Időszak: ${period}\n` +
      `Mód: ${a.mode}\n` +
      `Determinisztikus válasz (tartsd meg az összes azonosítót):\n${a.summary}\n` +
      `Egyéb értelmezések:\n${alternates}`
    );
  }
  return (
    `Question: ${a.question}\n` +
    `Period: ${period}\n` +
    `Mode: ${a.mode}\n` +
    `Deterministic answer (keep every identifier exactly):\n${a.summary}\n` +
    `Other interpretations:\n${alternates}`
  );
}

/**
 * Rewrite the deterministic summary via the Kilo Gateway. Returns the
 * model's text, or null on ANY failure (unconfigured, network error,
 * non-2xx, timeout, empty/blank response). Callers MUST fall back to
 * the deterministic summary when null.
 */
export async function renderLlmAnswer(
  args: RenderLlmArgs,
  timeoutMs: number = LLM_TIMEOUT_MS,
): Promise<string | null> {
  if (!llmConfigured()) return null;
  const key = (process.env.KILO_API_KEY ?? "").trim();
  const base = llmBaseUrl();
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM_PROMPTS[args.language] },
          { role: "user", content: buildUserPrompt(args) },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const text = content.trim();
    return text.length > 0 ? text : null;
  } catch {
    // Timeout (AbortError), DNS, connection reset, JSON parse — all
    // degrade to the deterministic answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
