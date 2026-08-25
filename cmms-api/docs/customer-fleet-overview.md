# Customer fleet overview + bare-name detection

**Status:** design + implementation plan
**Branch:** mcp-redesign-phase6 (proposed)

## Problem

The current router requires a `Kft.|Zrt.|Bt.|Rt.|Nyrt.|Kkt.|Kkt.|Kkt.` legal
suffix or a `-nél` suffix (or an English `for/at` lead) to extract a customer.
That misses three common shapes:

| Hungarian phrasing                          | What it is               | Current behavior        |
| -------------------------------------------- | ------------------------ | ----------------------- |
| `az SVG HDMC gépében az y2 hajtás`          | Compound with bare name  | Routed to `device="SVG HDMC"` (wrong) |
| `Hány ticketje van az SVG HDMC-nek?`         | Drill-down, bare name    | Routed to `search_tickets` (0 hits)   |
| `SVG HDMC`                                  | Fleet query              | Routed to `search_tickets` (gets results but not a structured overview) |

There is no way to ask "show me this company's whole fleet — what machines,
what problems, when was the last visit, who's their tech" in one question
without the user already knowing the company's exact legal name.

## Decisions (from ask_user)

1. **Bare-name detection:** probe the customers DB on every question. If
   a 2-token phrase where every token starts with a capital letter and
   there is no legal suffix / no `-nél` suffix matches an actual
   customer in the DB, treat it as the customer.
2. **Fleet-overview answer shape:** 5-section composite:
   - Total ticket count + distinct machine count + first/last seen
   - Top 5 machine types by ticket count
   - Top 5 failure categories
   - Last 5 tickets (sorszam + date + 1-line summary)
   - 1-line natural-language summary
3. **Grammar:** routing only. Leave the user's wording alone.

## Design

### 1. New `extractCustomer` pattern in `src/lib/router.ts`

Add a 4th pattern (after the existing Kft./-nél/for patterns):

```typescript
// "SVG HDMC", "MÁV TR", "ContiTech" — 1-3 capital-initial tokens
// with no Kft./-nél suffix. We mark these as "weak" so the answer
// handler can DB-probe them; a false-positive here is cheap (~5ms)
// and a true positive unlocks a whole category of questions.
const BARE_NAME_RE = /\b([A-ZÁÉÍÓÖŐÚÜŰ][A-ZÁÉÍÓÖŐÚÜŰa-záéíóöőúüű0-9&.\-]{1,30}(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ][A-ZÁÉÍÓÖŐÚÜŰa-záéíóöőúüű0-9&.\-]{1,30}){0,2})\b/g;
```

The regex is permissive (e.g. would match "Melyik Ügyfél") so we add a
negative lookbehind: don't fire when the matched token is a known
question word leader ("Melyik", "Mikor", "Hány", "Milyen", etc.) or
when the previous word is `az`/`a`/none.

Crucially: a "bare" extraction is **tagged** as such (returned via a
new tuple `{ name: string, weak: boolean }` or a side-channel set on
the returned string). The answer handler reads the tag and runs the
DB probe.

### 2. Customer-probe in `src/routes/answer.ts`

Between `routeQuestion(q)` and `executePlan(cache, dbs, plan)`:

```typescript
if (plan.filters.customer && isWeakCustomer(plan.filters.customer)) {
  const probe = await probeCustomer(dbs, plan.filters.customer);
  if (probe) {
    // promote to strong customer + update intent
    plan.filters.customer = probe.canonical;
    plan.customer_aliases = probe.aliases;     // for follow-ups
    if (isFleetQuery(q)) plan.intent = "customer_fleet_overview";
  } else {
    // false positive — fall through to the original (likely device) plan
    delete plan.filters.customer;
  }
}
```

`probeCustomer` calls the existing `search_customers` SQL query
(inline, no HTTP) and picks the top hit by `ticket_count`.

### 3. New intent `customer_fleet_overview`

A new branch in `executePlan` (after the existing customer_* branches
in `buildSummary`):

```typescript
if (plan.intent === "customer_fleet_overview") {
  // 5 sub-queries run in parallel against the JobCache
  const [total, topMachines, topCategories, last5, firstSeen] = await Promise.all([
    cache.countBy({ customer, period }),                          // 1
    cache.stats({ customer, group_by: "machine_type", limit: 5 }),  // 2
    cache.stats({ customer, group_by: "kategoria_inferred", limit: 5 }),  // 3
    cache.search({ customer, order: "recent_desc", limit: 5 }),  // 4
    cache.search({ customer, order: "oldest", limit: 1 }),       // 5
  ]);
  return { results: { total, topMachines, topCategories, last5, firstSeen } };
}
```

`buildSummary` for this intent renders the 5-section composite in
Hungarian (default) or English:

```
SVG-HUNGARY GÉPGYÁR ZRT. — flotta áttekintés (2024-2026, 47 ticket)

Gépek (top 5): HDMC-130 (12), TMV-400 (8), DPB-3 (5), NCT-204 (3), IPS1-2 (2)
Hibakategóriák (top 5): Mechanikai hiba (14), Vezérlő hiba (9), Szoftver hiba (7), Arampitlasi hiba (3), Kijelző hiba (2)
Utolsó 5 ticket: B26060502 (2026.06.05), B26050601 (2026.05.06), B25120318 (2025.12.03), B25110602 (2025.11.06), B25103007 (2025.10.30)
Első/utolsó: 2024.07.17 → 2026.06.05
Legutóbbi látogatás: 2026.06.05, HDMC-130 betanítási ajánlat.
```

### 4. Trigger: when is the new intent used?

A "fleet query" is:
- Question is just a bare customer name (no verbs, no question word)
- OR question starts with "show me / mutasd [Customer]" / "everything for [Customer]"

A compound question like "Hány alkalommal ment tönkre az SVG HDMC
gépében az y2 hajtás" is **not** a fleet query — it's a single-fact
question that should hit `customer_tickets_list` with the `q` "y2
hajtás" filter threaded through. (See fix below — the existing
`customer_tickets_list` already threads the leftover `q`, so the
question routing is OK once `customer` is correctly extracted.)

### 5. Tests

**`tests/38-customer-fleet.test.ts`** (new):
- `extractCustomer` finds bare names
- `extractCustomer` does not false-positive on "Melyik ügyfél"
- `probeCustomer` matches "SVG HDMC" → "SVG-HUNGARY GÉPGYÁR ZRT."
- `probeCustomer` returns null for "FOO BAR BAZ" (no such customer)
- `customer_fleet_overview` returns all 5 sections for "ANDRITZ Kft."
- `customer_fleet_overview` formats 5-section Hungarian composite
- `customer_fleet_overview` formats English composite
- `customer_fleet_overview` returns honest not-found if alias doesn't match anything
- end-to-end: "SVG HDMC" question → 5-section answer with correct machine counts

## Files to touch

| File                                       | Change                                                              |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `src/lib/router.ts`                        | New `extractCustomer` 4th pattern, new `customer_fleet_overview` intent + branch |
| `src/lib/hu.ts`                            | (no change)                                                          |
| `src/routes/answer.ts`                     | `probeCustomer` helper, intent promotion logic, 5-section executePlan branch, 5-section buildSummary |
| `src/db/open.ts`                           | (no change — reuses existing customers table)                        |
| `tests/10-router.test.ts`                  | +5 cases for `extractCustomer` bare-name patterns                    |
| `tests/38-customer-fleet.test.ts` (new)    | 9 cases: probe + fleet intent + end-to-end                           |
| `docs/cmms-mcp-redesign.md`                | Phase 6 entry                                                        |

## Rollout

1. Implement
2. `bun test` (target: 625+ tests pass, 0 fail)
3. `bunx tsc --noEmit` clean
4. Manual probe: "Hány alkalommal ment tönkre az SVG HDMC gépében az y2 hajtás"
   → customer-scoped, y2 hajtás filter threaded, ticket count returned
5. Manual probe: "SVG HDMC" → 5-section fleet composite
6. Deploy via `bun run deploy-binary.ts` (no schema change; no MCP/server change)
7. Add Phase 6 to AGENTS.md changelog

## Out of scope (for this phase)

- Free-text "show me everything for [Customer]" parsing (handled by fleet trigger)
- Hungarian declension improvements beyond the existing `huThe` helper
- Saving user-validated customer aliases (deferred; the DB-probe is good enough)
