# Option 2 Agent — Design Doc

**Status:** Draft (in review)
**Date:** 2026-08-18
**Author:** Mavis
**Target branch:** `mcp-redesign-phase5`

---

## 1. Background

The current `/v1/answer-agent` loop delegates answer composition to a single
high-level tool (`answer_question`). The LLM's job is reduced to "call it, then
relay the result." In practice this means:

- The model cannot **cross-reference** (e.g. "did this device ever come up
  in `serviz_belso`?")
- The model cannot **drill down** ("OK I have the ticket, now show me the
  device history")
- The model cannot **verify** (the canned summary is treated as gospel;
  wrong sorszams are relayed verbatim)
- The model frequently **gives up** ("nincs információ") even when 8 calls
  worth of evidence is sitting in its context — because the high-level tool
  either compressed the evidence too aggressively or the model never learned
  to read it.

The 28-tool MCP surface is already there. The router in `src/lib/router.ts`
already dispatches to the right primitive. The primitives (`search_tickets`,
`get_ticket_stats`, `find_related_tickets`, `get_problem_cluster`,
`find_spare_motor`, `search_customers`, `find_linkage`) already exist and are
tested. The bottleneck is **the agent's tool policy and loop**, not the data
layer.

This document specifies the move to **option 2**: the LLM is the reasoner,
the tools return raw evidence, the loop supports parallel tool calls, and
the tool surface is the only CMMS-only constraint (no system-prompt begging).

---

## 2. Goals & non-goals

### Goals

1. **LLM composes the final answer from raw evidence.** Every tool returns
   structured JSON (sorszam, snippet, date, source). The model writes the
   answer in the user's language and cites the source sorszams.
2. **Parallel tool calls per turn.** When the LLM emits 2–5 `tool_use`
   blocks in one assistant turn, the loop dispatches them concurrently and
   feeds all results back in the next turn.
3. **Medium-grained tool surface.** The agent's primary kit is ~7–8
   intent-grouped tools. Mutate tools stay in the surface but are guarded.
4. **Reproducibility bar: ≥ 90% on the 100-question catalog** (was ~65%). High bar — a 25-point jump from current, achievable with parallel calls + the registry simplification alone, but we won't flip the default until the catalog actually clears it on prod.
5. **Big-bang rollout** behind `ASK_AGENT_V2=1` env var on day one; default
   flips to v2 after a 1–2 day soak.

### Non-goals

- We are **not** rewriting the data layer. The router, primitives, and DB
  are unchanged.
- We are **not** adding new primitives. All target tools exist.
- We are **not** exposing any tool outside the CMMS domain. No web, no
  file system, no arbitrary code. The tool surface IS the scope constraint.
- We are **not** swapping the LLM provider. `KILO_MODEL=openai/gpt-4o-mini`
  stays.

---

## 3. Architecture

### 3.1 Current loop (one tool per turn, serial within turn)

```
for i in 0..MAX_ITER:
  resp = LLM.chat(messages)
  if resp.tool_calls.is_empty():
    return resp.content          // final answer
  for tc in resp.tool_calls:     // SERIAL
    result = callAgentTool(tc)
    messages.push(tool_result)
```

### 3.2 New loop (parallel tools per turn)

```
for i in 0..MAX_ITER:
  resp = LLM.chat(messages)
  if resp.tool_calls.is_empty():
    return resp.content
  if resp.tool_calls.length > 1:
    results = await Promise.all(callAgentTool(tc) for tc in resp.tool_calls)
  else:
    results = [await callAgentTool(resp.tool_calls[0])]
  for (tc, result) in zip(resp.tool_calls, results):
    messages.push(tool_result_for(tc, result))
```

Two things to be careful of:

- **`callAgentTool` already does its own per-tool timeout (60s) and
  AbortController** (`src/lib/agent_tools.ts:625+`). `Promise.all` is safe —
  if one tool hangs, its own timer fires; the others complete normally.
- **Trace order matters for the dashboard.** We dispatch in parallel but
  emit `trace` entries in the original `tool_calls` order so the live
  stream renders correctly.

### 3.3 Tool surface (v2)

The agent gets **8 primary read tools + the mutate set**, down from today's
26. The high-level `answer_question` tool stays in the registry as
`answer_question_legacy` for fallback, but the v2 system prompt never
mentions it.

| New (v2) name | Replaces | Returns |
|---------------|----------|---------|
| `find_ticket` | new | Single ticket card by sorszam (B/J/M) |
| `search_tickets` | `search_tickets`, `search_existing_tickets`, `search_by_category` | List of hits with sorszam, snippet, dates, source |
| `get_device_history` | new | All tickets for a device, grouped, with sorszams |
| `find_related_tickets` | `find_related_tickets` | Cross-DB timeline (main + serviz_belso + szev_igeny + telephely_munka) |
| `get_ticket_stats` | `get_ticket_stats` | Aggregations with sample sorszam evidence |
| `list_customers` | `search_customers` | Substring search + per-customer counts |
| `find_spare_motor` | `find_spare_motor` | AiS stock match with score |
| `find_linkage` | `find_linkage` | Sorszam cross-reference graph |
| **mutate**: `create_ticket`, `modify_ticket`, `close_ticket`, `add_ticket_tag`, `set_ticket_category`, `set_ticket_severity` | unchanged | As today, but **not exposed unless `ASK_AGENT_ALLOW_MUTATE=1`** |

Aliases (`search_existing_tickets`, `get_problem_cluster`,
`find_recurring_problems`, `search_serviz_belso`, `get_serviz_ticket`,
`search_szev_igeny`, `search_telephely_munka`, `search_ais_motor_inventory`,
`get_failure_rates`, `customer_canonical`, `get_integration_stats`,
`get_categories`, `get_tags`) are **kept in the MCP surface for the
dashboard's raw search, but excluded from `AGENT_TOOLS` in v2**. The agent
hits the broad ones; niche ones the dashboard uses are not in its path.

**Why drop them from the agent?** The LLM has ~8 working slots for tools in
its head. More than ~10, and tool-selection accuracy collapses (we measured
this — 26 tools → ~65% reproducibility; 8 tools → projected ~85%+ based on
internal 2026-08-12 GPT-4o-mini evals).

### 3.4 System prompt (v2)

```
You are the CMMS assistant for an industrial machine service business
(NCT controllers, CNC machines, Hungarian customer base).

You answer the user's question by calling the tools below and reasoning
across the results. You write the final answer yourself in the user's
language.

RULES
1. ALWAYS use the tools. Never answer from general knowledge.
2. PREFER calling 2–5 tools in parallel when the question has multiple
   facets (e.g. "is this device problematic" → search_tickets for the
   device + get_ticket_stats by device + get_failure_rates in one turn).
3. CITE real sorszams. Never invent ticket numbers. If a tool returned
   0 hits, say so honestly.
4. When the question is ambiguous, ask a follow-up.
5. If the user asks something outside CMMS, refuse briefly and offer
   a CMMS-relevant reframing. Do not attempt to answer off-topic
   questions even if you "know" the answer.

WHEN TO USE WHICH TOOL
- find_ticket(sorszam) — known ticket number
- search_tickets(q, customer, device, period, status, kategoria, limit)
  — open-ended question, or to verify a hypothesis
- get_device_history(device) — "everything about this device"
- find_related_tickets(sorszam or customer+device) — full timeline across
  all 4 DBs
- get_ticket_stats(group_by, period) — counts, top-N, aggregations
- list_customers(query) — name lookup
- find_spare_motor(serial, motor_type, problem) — replacement motor
- find_linkage(sorszam) — "which other tickets reference this one"

OUTPUT FORMAT
- Plain prose in the user's language (hu or en)
- Bullet the cited sorszams (e.g. "B26071801 (PLASMA-TECH, 2026-07-18)")
- Keep it concise: 1–4 sentences for simple lookups, longer for synthesis
```

### 3.5 Dashboard surface (tree visualization)

The live stream's tool trace becomes a tree:

```
┌─ think: "M26057 + 2026-07-18 → I'll pull the ticket, the device history,
│         and any related serviz_belso entries in parallel"
├── 🔧 find_ticket(sorszam="B26071801")             [0.4s, ok]
├── 🔧 get_device_history(device="M26057")          [0.9s, ok]
└── 🔧 find_related_tickets(sorszam="B26071801")    [1.1s, ok]
    ↳ synthesis: "Az M26057 vezérlése NCT 4… B26071801, B25082210…"
```

Implementation: the SSE stream's `tool_call` events now carry
`{id, parent_id, parallel_group_id}`. The dashboard's `AgentBody.vue`
groups siblings by `parallel_group_id` and renders them as tree nodes.

Wire format (additive — old clients still work):

```ts
type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  note?: string;
  // NEW in v2:
  parallel_group_id?: string;   // all calls in the same turn share one
  started_at?: number;          // epoch ms
  ended_at?: number;            // epoch ms
};
```

### 3.6 Mutate guard

The 6 mutate tools are present in `AGENT_TOOLS` only when
`ASK_AGENT_ALLOW_MUTATE=1`. Default: **off** for v2. The system prompt does
not mention them. If the model somehow calls one, `callAgentTool` returns
`{ ok: false, note: "mutate_disabled" }` and the loop continues.

We flip this on manually once v2 reads look stable in prod (day 2+).

---

## 4. File-level changes

| File | Change |
|------|--------|
| `src/lib/agent_tools.ts` | Add `AGENT_TOOLS_V2` (8 tools + mutate-gated). Keep `AGENT_TOOLS` (legacy) untouched. Add `AGENT_TOOLS_PRIMARY` env-driven selector. |
| `src/lib/agent.ts` | New `runAgentV2()` function. Parallel dispatch via `Promise.all`. New system prompt `SYSTEM_PROMPT_V2`. Reuse `compactToolText`, `extractTicketCardsFromAnswer`, `digestAnswerToolResult` (drop `digestAnswerToolResult` call for non-`answer_question` tools). |
| `src/routes/answer.ts` | `POST /v1/answer-agent` routes to `runAgent` (today) or `runAgentV2` (when `ASK_AGENT_V2=1` or after flip). Both return the same `AgentOutcome` shape; v2 adds `parallel_tool_calls: true` to `AgentOutcome`. |
| `mcp-server.ts` | When `ASK_AGENT_V2=1`, `answer_question` MCP tool calls `/v1/answer-agent?agent=v2`. When off, calls today's path. No breaking change to the MCP surface. |
| `tests/30-agent-v2.test.ts` (new) | Parallel-call loop, tool-surface selection, system-prompt sanity, mutate guard. |
| `tests/31-v2-replay.test.ts` (new) | Replays the 100-question catalog against v2 (offline; no LLM — uses recorded answers or stubs). |
| `docs/option-2-agent.md` | This file. |

`AGENT_TOOLS` (legacy 26) and `runAgent` (today's serial loop) are kept
**until v2 is the default**. They are deleted in a follow-up commit.

---

## 5. Rollout

| Day | Action | Reversible? |
|-----|--------|-------------|
| 0 | Land v2 behind `ASK_AGENT_V2=1`. Server env unchanged (off by default). Run full test suite (must be 100% green). | Yes |
| 0 | Deploy. Soak 1–2 hours with `ASK_AGENT_V2=1` for internal probes. | Yes (toggle off, restart) |
| 0 | Flip `ASK_AGENT_V2=1` server-wide. Monitor `agent_answer_digest` / `agent_tool_call` / iteration count for 24h. | Yes |
| 2 | Replay the 100-question catalog against prod. If ≥90% pass, ship the v2-default commit (removes the flag check). | No (one-way) |
| 3+ | Delete `AGENT_TOOLS` legacy, `runAgent` legacy, `digestAnswerToolResult`. | No |

The dashboard's tree visualization is independent and can ship in any
order. If the wire-format additions are in but the v2 loop is off, the
dashboard renders a single-child tree (looks the same as today).

---

## 6. Verification

| Check | How | Pass bar |
|-------|-----|----------|
| TypeScript compiles | `bunx tsc --noEmit` | exit 0 |
| Full test suite | `bun test` (with parallel-session tests skipped) | 100% green |
| Loop is parallel | `tests/30-agent-v2.test.ts` — stub LLM emits 3 tool calls, expect `Promise.all` (assert: total wall time ≈ slowest, not sum) | < 1.5× slowest single call |
| Tool surface | `tests/30-agent-v2.test.ts` — assert `AGENT_TOOLS_V2.length === 8` + mutate set is empty by default | exact |
| Reproducibility | `tests/31-v2-replay.test.ts` — replay 100 questions, count citations match expected sorszams | ≥ 90% |
| Prod smoke | 4 manual probes (Q1 Q2 Q3 Q4 from the 100-set) | 4/4 cite real sorszams |

---

## 7. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| GPT-4o-mini ignores new system prompt and falls back to legacy behavior | Med | Med | The 8-tool registry is hard; the model literally cannot call the old 26. If it hallucinates tool names, `callAgentTool` returns `unknown_tool` and the loop nudges it. |
| Parallel calls overwhelm `/v1/answer` (3-5 concurrent) | Low | Med | The 8 v2 tools hit different endpoints (`/v1/jobs/*`, `/v1/integration/*`). No single endpoint takes >2 calls per turn. |
| Tree visualization breaks the existing dashboard | Low | High | Wire format is additive. Old clients ignore new fields. Tree UI is opt-in via a `?agent=v2` query param. |
| Mutate guard is too restrictive | Low | Low | `ASK_AGENT_ALLOW_MUTATE=1` env toggle. |
| 100-question regression slips below current 65% | Med | High | Rollout is `ASK_AGENT_V2=1` first; we don't flip default until the catalog replay passes. The catalog is replayed against prod *before* the flip commit. |

---

## 8. Open questions

1. **Should the v2 system prompt explicitly tell the model about the
   "no `answer_question` tool" rule, or rely on absence-from-the-registry?**
   My recommendation: absence. The model's tool selection is driven by the
   registry; telling it "don't use X" is weaker than just not offering X.
2. **Does the dashboard's tree need a "flatten" toggle for power users?**
   Defer to a follow-up.
3. **Should the per-turn tool-count limit be hard-capped at 5?**
   My recommendation: yes. >5 tool calls in one turn usually means the
   model is fishing; we want to redirect it to reason harder, not call more.

---

## 9. Next step

Land the v2 tool registry + parallel loop behind `ASK_AGENT_V2=1`, ship the
new tests, deploy, and soak. ~half a day of focused work, no behavior change
for prod until the env var is flipped.
