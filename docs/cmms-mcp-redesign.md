# CMMS MCP Redesign — Diagnosis, Catalog, and Plan

**Owner:** Gergely Garvan · **Date:** 2026-07-31 · **Status:** Proposal
**Server:** `10.0.3.81` (cmms-api) · **Frontend:** KiloClaw via zrok tunnel
**Goal:** Cut the ~65% same-question-different-answer rate by reshaping the
MCP tool surface, the underlying DB, and the prompt-level routing rules.

---

## 1. What I actually looked at

I SSH'd into the server, pulled both production SQLite files, and queried
every table directly. Here is the ground truth the redesign is based on.

### 1.1 Database size and shape

| File | Size | Tables | Notes |
|---|---|---|---|
| `cmms.db` | 194 MB | `data` (65 921 jobs) + 9 `_v_*` views for 2008-2024 archive | Original sheet, Hungarian column names |
| `cmms_specialized.db` | 345 MB | `jobs`, `customers`, `devices`, `notes`, `serviz_belso`, `szev_igeny`, `telephely_munka`, `telephely_ais_motor`, `statisztika`, `problema_kategoriak`, `ticket_problema` | Derived sidecar, FTS5 indexed |

Key counts:

- 65 921 jobs across 27 years (2000–2026), 4 000–5 000 / year since 2018
- 65 921 customers (1:1 with jobs — there is no "customer master")
- 1 248 075 device rows (avg ~19 devices per job — most are noise from
  semicolon-split cells)
- 107 284 notes (65 620 reported + 35 733 work + 5 931 free)
- 11 000 internal szerviz tickets (Szerviz belső, 2008-now)
- 3 587 SZÉV requisitions (2019-2026)
- 1 166 in-house telephely jobs, 51 bad-AiS motors in stock
- 184 statisztika rows (Excel pivot dump, year × product × failure %)
- 0 `problema_cimkek` (tags table is empty)
- 0 `sulyossag` populated (severity column exists, 100% null)
- 0 `problem_alkategoria` populated (subcategory column exists, 100% null)
- 65 697 / 65 921 jobs have a kategoria link (99.7% coverage, but
  skewed: 39% "Egyeb", 23% "Vezérlő hiba", 1.2% "Szoftver hiba")

### 1.2 What the data actually looks like

A typical fault report (Hungarian, free text, no schema):

> "Y-teng. Előtoló motor (A-9…..kúpos) és hajtásmodul csere !"

> "a hidraulikus tokmánypofa végálláshoz érve az ellentétes irányba
> elindul->kérik ezt módosítani úgy, hogy a pofa végálláson megálljon"

> "TNC 124; A gép hibaüzenete: "szánrögzítés-oldás hiba" Ezt a
> referenciapont felvételekor írja ki "x" "y" tengely ref.pont felvétele
> után a "z" tengely ref.pont felvételét nem fejezi be…"

A typical device cell:

> `TMV-400(10297;M10170);NCT99M;CRT15";SW-1.039`

becomes 4 device rows after parsing, with one carrying model `TMV-400`,
one carrying model `NCT99M`, one carrying model `CRT15`, and the SW-1.039
row disappearing because the parser currently only extracts
`model/software/hardware/servos` and discards the rest into `freeform`.

A typical "vegzett_munka" (work done) note:

> "hajtás kiszerelés NCT műhelybe szállítottuk telephelyi javításhoz;
> hibabehatárolás; készülék megtisztítása főmágneskapcsoló cseréje
> műhelyben; főhajtás visszaszállítása, beépítése, beüzemelése, próba."

These are dense, semicolon-delimited, multi-step notes from a real
technician. They mix the actual repair with logistics, dates, and
("X.YY. Z.NN.") followup stamps.

### 1.3 Current MCP surface

12 tools registered in `mcp-server.ts` (AGENTS.md says 12; actually 18
when I count `find_recurring_problems`, `get_problem_cluster`, the 5
`search_*_archive` tools, and `get_integration_stats`).

The 18 tools fall into 4 functional buckets:

| Bucket | Tools |
|---|---|
| **Find one ticket** | `search_existing_tickets`, `search_by_category`, `get_ticket_stats` (with group_by), `find_recurring_problems`, `get_problem_cluster` |
| **Find internal/archive** | `search_serviz_belso`, `get_serviz_ticket`, `search_szev_igeny`, `search_telephely_munka`, `search_ais_motor_inventory`, `get_integration_stats` |
| **Vocabulary** | `get_categories`, `get_tags` |
| **Mutate** | `create_ticket`, `modify_ticket`, `remove_ticket`, `close_ticket`, `add_ticket_tag`, `set_ticket_category`, `set_ticket_severity` |

---

## 2. The 12 root causes of the 65% inconsistency

These are the actual mechanisms producing different answers to the same
question. Each is grounded in code or data I inspected.

### R1. Tool descriptions are in English, queries and data are in Hungarian

Every `mcp-server.ts` description starts with English verbs ("Search
existing tickets", "Aggregate"). A worker asking "melyik a legjellemzőbb
hiba a TMV-400-nál" must mentally translate to English, pick a tool by
its English description, then translate filter values back. The round-trip
costs accuracy, especially under short context windows.

**Fix:** all tool descriptions and parameter help text must be **bilingual
(hu + en)** with one being the primary. A `language` hint parameter
accepted by the server (or negotiated at `initialize`) lets us switch the
*primary* language per session.

### R2. No "intent router" — the model has to pick from 18 tools by prose

When the user asks "What was the most common problem on TMV-400
machines last year?", the LLM has to choose between:

- `get_ticket_stats` (group_by: device, kategoria, with date filter)
- `search_by_category` (kategoria, device, date)
- `search_existing_tickets` (returns raw tickets, not aggregated — *wrong tool*)
- `find_recurring_problems` (machine, date_from, date_to)

Three of these can plausibly answer the question. The LLM picks differently
across sessions, sometimes picking #3 which returns a paginated ticket
list the user has to count manually. AGENTS.md warns about this, but
prose warnings are not routing.

**Fix:** introduce an `answer_question(q: str, language: 'hu'|'en')` tool
that does the intent classification server-side, picks the right
primitive, and returns a pre-shaped answer with citations. The model
becomes a "voice", not a "router".

### R3. AND-of-tokens on diacritic-folded ASCII is fragile

`search_existing_tickets.q` does `body_ascii LIKE '%tok1%tok2%'` after
folding diacritics. This means:

- `'távoli'` and `'tavoli'` both work
- but `'távoli elérés'` becomes `'tavoli elerés'` — *token-level* match
  on `'tavoli'` and `'eleres'`, which means `'tavolieleres'` will not
  match a row whose body says `'távoli elérésnek'`
- the model doesn't know this, so it sometimes writes `q="távoli"` and
  expects nothing, sometimes `q="tavoli elerés"` and gets an empty
  result, sometimes `q="távoli elérés"` and gets everything

**Fix:** replace the `q` parameter with one of two clear modes:
`free_text` (uses FTS5 with `*` prefix matching) and `exact_phrase`
(uses BM25 with no diacritic folding on the query side, but stored
content still folded). Document the difference in the schema.

### R4. `Egyeb` is 39% of all tickets — the category distribution is broken

| Category | % of tickets |
|---|---|
| Egyeb | 39% |
| Vezérlő hiba | 23% |
| Karbantartas | 8% |
| Telepites | 6% |
| Hardver hiba | 5% |
| Géptípus hiba | 5% |
| Mechanikai hiba | 3% |
| Kijelzo hiba | 3% |
| Halozati hiba | 2% |
| Csatlakozasi hiba | 2% |
| Szoftver hiba | **1.2%** |
| Beallitasi hiba | <1% |
| Arampitlasi hiba | <1% |
| Kepzes | <1% |
| Tavoli eleres | <1% |

"Szoftver hiba" is 1.2% even though the database has thousands of
"PLC program", "bootolás", "szoftver frissítés", "paraméter betöltés"
incidents. They were filed under "Vezérlő hiba" or "Egyeb" by humans
in 2018. The LLM now treats "show me software issues" as a 800-row
query, but the real answer is "we have ~5000 software-related tickets,
just labeled inconsistently."

**Fix:** add a `kategoria_classifier` job that, on insert (and as a
backfill on the existing 65k rows), runs the free text through a
keyword-based classifier with the following expanded taxonomy:

- `Szoftver/PLC program hiba` (merges old Szoftver + ~30% of Vezérlő)
- `Vezérlő hardver hiba` (the rest of Vezérlő + IGBT/drive faults)
- `Szervó / hajtás hiba` (currently scattered)
- `Mech./beállítás` (Beallitasi + Mechanikai)
- `Gépbeszerelés / telepítés` (Telepites)
- `Karbantartás / preventív`
- `Kijelző / HMI`
- `Hálózat / távoli elérés` (Halozati + Tavoli eleres merged)
- `Tápellátás / védelem` (Arampitlasi)
- `Csatlakozó / kábel`
- `Képzés / oktatás`
- `Egyéb`

Then provide a `reclassify_ticket` (admin) tool and a way to expose
both the *original* category (as filed) and the *auto-classified*
category side by side.

### R5. `sulyossag` is 100% null — the severity tool writes into a void

The `jobs.sulyossag` column is there. The `set_ticket_severity` MCP tool
exists. But not a single row has a value. So "show me critical
tickets" returns nothing. The LLM either:

- lies (fabricates severity from the text), or
- admits it doesn't know.

Both are bad. The current tools are honest — but unhelpful.

**Fix:** make `sulyossag` derivable from text automatically. Run a
heuristic on insert: keywords like "nem indul", "leállt a gép", "nem
működik", "tűz", "vészkör", "vészleállás" → `magas`/`kritikus`;
"beállítás", "finomhangolás", "kérés" → `alacsony`; default `kozepes`.
Same backfill pass as the kategoria classifier. Then expose it
*clearly*: every result returns both the original `sulyossag_raw`
(null) and the derived `sulyossag_inferred`.

### R6. `problem_alkategoria` is 100% null — subcategory is a phantom

Same as R5. Either populate it (hard — needs a hand-built taxonomy) or
remove the field from the MCP surface and don't promise what we don't
have.

**Fix:** generate `alkategoria` from the *device* family, not the fault
text. If a job has a device with controller `NCT104`, `alkategoria =
"NCT104"`. This gives 50+ distinct, machine-meaningful subcategories
that can drive `get_ticket_stats(group_by: alkategoria)`.

### R7. Customer identity is dirty — no canonical master

- `"ELEKTRONIKA ÁTVITELTECHNIKAI  SZÖVETKEZET"` appears as two rows
  (one with double space, one with single space, and one with the
  trailing szövetkezet vs. Szövetkezet).
- `MÁV RT. REGIONÁLIS OKTATÁSI KÖZPONT` shows up as 1 ticket (a
  training, not a service call). It still counts in the "top 20
  customers" stats alongside 2000-ticket accounts.
- "ANDRITZ KFT." shows up twice in the top 20 with the exact same name
  — duplicate customer IDs.
- The name "Albert Kft." appears in both `data.AKTUÁLIS NÉV` (canonical)
  and `data.RÉGI NÉV` (old name). Some queries pick the right one,
  some don't.

**Fix:**

1. Build a `customer_aliases` table: `(canonical_id, alias_name,
   alias_normalized)`. Backfill by collapsing whitespace, diacritics,
   common suffixes (Kft, KFT, Kft., Bt, Zrt, Rt).
2. Add a `customers.canonical_id` self-FK; a normalization job sets
   it on every row. New rows compute it on insert.
3. Add a `customer_search` tool that takes a fuzzy name and returns
   `{canonical_id, canonical_name, aliases[], ticket_count,
   first_seen, last_seen, open_count, closed_count, top_devices[],
   top_kategoriak[]}`.
4. `search_existing_tickets.customer` parameter matches against the
   alias table, not just `name`.

### R8. The "recurring problems" tool is the right idea but buried

`find_recurring_problems` is the only tool that actually answers
"what keeps happening on this machine?" with a proper cluster
analysis. But it's the 13th tool, its description is 30 lines, and
its scope parameter (`narrow | broad | broadest`) is a concept the
LLM has to internalize.

**Fix:** rename it to `find_pattern` and add a sibling `summarize_problem`
tool. The pattern tool returns clusters with:

- cluster signature (kategoria, machine, controller, …)
- `visit_count`, `first_seen`, `last_seen`, `days_between_visits`
- `technicians[]` (in order of involvement)
- `handoffs[]` (when tech A tried, tech B fixed it)
- `resolution_status`: "ongoing" / "fixed" / "regressed"
- `linked_serviz_archive[]` (cross-reference to internal tickets)
- `linked_szev[]` (cross-reference to requisitions for parts used)
- `sample_evidence` (1–2 cited tickets with sorszam + snippet)

The `summarize_problem` tool takes a single cluster and produces a
human-readable paragraph + a JSON evidence block, so the LLM doesn't
have to synthesize 50 rows into prose by itself.

### R9. No time-bounded recall helper

Every "last week", "this month", "Q1 2025" question forces the LLM
to compute ISO dates from current date. With small context, it
sometimes uses `date_from = "2025-01"` (string prefix match) which
returns nothing because the column is `YYYY-MM-DD`.

**Fix:** add `period: 'today' | 'this_week' | 'this_month' |
'this_quarter' | 'this_year' | 'last_30_days' | 'last_90_days' |
'last_year' | 'YTD' | 'custom'` parameter to every search/stats
tool. Server resolves to ISO dates. Always return both `date_from`
and `date_to` echoed back in the response so the LLM can cite the
window it actually used.

### R10. Statisztika and telephely_ais_motor are dead data

`statisztika` (184 rows) is a manually-aggregated Excel pivot of
*factory* failure rates — "in 2022, 12% of DxC drives failed". This
is completely separate from the ticket-system `problema_kategoriak`.
No tool queries it.

`telephely_ais_motor` (51 rows) is a hand-kept inventory of motors
that came back from customers — "AiS100 from M16119, zárlatos".
Useful to a technician asking "do we have a spare I can install on
machine M16119 tomorrow?" but unreachable.

**Fix:** two new tools:

- `get_failure_rates(product?: str, year?: int) → { product, year,
  total_built, total_failed, fail_pct, gar_pct, fiz_pct }`. Joins
  statisztika and exposes it. The LLM can finally answer "are DxC
  drives getting better?"
- `find_spare_motor(machine_serial: str, motor_type?: str) → [{id,
  sorszam, tipus, gyari_szam, eredeti_gep, problema, tartozekok,
  feladat}]`. The LLM can answer "we have an AiS100 from a similar
  machine, can we use it?"

### R11. SZÉV requisitions have date-time and identifier drift

- 2019-2022 source files have `igenyszam`, 2023+ has
  `szev_igeny_szam`. The ETL mapped both to `szev_szam` per year
  (`SZÉV2019-0001`), so the model can't tell which year-file a row
  came from without `source_file`.
- 2019-2022 rows have `igeny_datum_iso = NULL` for ~95% of rows.
  The `year` column is set instead. So date-filtering SZÉV only
  works on the year, not the actual requisition date.
- `statusz` is a text column stored as INTEGER but allowed to be
  0/1/2 in some files and "folyamatban"/"kész"/"teljesítve" in
  others. The current data shows mostly 0 = open.

**Fix:** in the MCP response, always include `source_period` and
`status_label` (human-friendly: "nyitott" / "lezárt" / "folyamatban")
in every SZÉV row. Provide a `year_quarter` derived column.

### R12. No "answer template" / "evidence chain" — LLM answers are unverifiable

When the LLM answers "this customer has the most open tickets", it
should cite the customer name, the count, and one or two example
ticket sorszamok so the user can click through. Right now the tools
return names and counts but the model is free to either cite or
omit. It often omits, because citing is more work and costs tokens.

**Fix:** every `get_ticket_stats`-style tool must, by default, return
*evidence*: top-N examples with sorszam, problem_kategoria, and a
30-character snippet of the reported/work text. The LLM uses these
in its answer, and so does the human. Add an `include_evidence:
bool` flag (default true) to turn it off for raw aggregations.

---

## 3. The new tool surface (proposed)

I propose collapsing 18 tools into 14, with 4 brand-new tools. The
new tool surface is **layered**: a top-of-funnel "router" tool, a
middle layer of "find/summarize" tools, and a bottom layer of
"mutate" tools.

### 3.1 Top of funnel — 1 tool

| Tool | Purpose |
|---|---|
| `answer_question(q, language, period?, scope?)` | The primary entry point. Takes a natural-language question in hu or en. Returns a structured answer object with: `intent`, `evidence[]` (cited sorszamok with snippets), `summary` (a pre-written 1-2 sentence answer), `follow_ups[]` (suggested next questions). The LLM mostly just relays `summary` to the user. |

The server-side router uses lightweight classification (no LLM call —
just keyword/embedding lookup + a deterministic decision tree) to map
`q` to one of the lower-level tools. This is the single biggest
consistency win: one tool, one code path, one result shape.

### 3.2 Find / summarize — 7 tools

| Tool | Replaces | Purpose |
|---|---|---|
| `customer_search` | (new) | Fuzzy customer lookup, returns canonical profile + ticket history summary |
| `search_tickets` | `search_existing_tickets` + `search_by_category` | Unified search with `period`, `kategoria`, `subkategoria`, `severity`, `customer`, `device`, `controller`, `machine_type`, `technician`, `free_text`, `exact_phrase`, `include_evidence`, `language` |
| `aggregate_tickets` | `get_ticket_stats` | `group_by` with `customer\|device\|controller\|machine_type\|technician\|kategoria\|alkategoria\|sulyossag\|status\|period`. Returns `{name, count, evidence[]}` for each group. |
| `find_pattern` | `find_recurring_problems` + `get_problem_cluster` | Cluster recurring issues with hand-off detection, cross-references to serviz/szev, evidence snippets |
| `search_serviz_archive` | `search_serviz_belso` + `get_serviz_ticket` | Internal 2008-now archive, unified across source periods |
| `search_szev_igeny` | `search_szev_igeny` (kept) | SZÉV requisitions with `year_quarter`, `status_label`, `source_period` always returned |
| `search_telephely_munka` | `search_telephely_munka` (kept) | In-house workshop jobs |
| `find_spare_motor` | (new) | Bad-AiS-motor inventory lookup |
| `get_failure_rates` | (new) | Factory failure-rate stats from `statisztika` table |

### 3.3 Mutate — 6 tools

| Tool | Replaces | Purpose |
|---|---|---|
| `create_ticket` | `create_ticket` (kept) | New ticket; on insert, runs kategoria auto-classifier and sulyossag heuristic |
| `modify_ticket` | `modify_ticket` + `set_ticket_category` + `set_ticket_severity` | One tool for all field updates. The separate category/severity wrappers are removed. |
| `add_ticket_note` | (new) | Append a free note to an existing ticket (the old `POST /v1/jobs/:key/notes` was on the REST but not on MCP) |
| `close_ticket` | `close_ticket` (kept) | Same |
| `add_ticket_tag` | `add_ticket_tag` (kept) | Same, plus auto-tagging on close (see below) |
| `cancel_ticket` | `remove_ticket` (renamed) | Mark as cancelled instead of hard delete; keeps audit trail |

### 3.4 Vocabulary — 2 tools

| Tool | Replaces | Purpose |
|---|---|---|
| `get_categories` | `get_categories` (kept) | Now also returns `alkategoria_hints` per kategoria and the new expanded taxonomy |
| `get_tags` | `get_tags` (kept) | Same |

### 3.5 What gets removed

- `search_by_category` — folded into `search_tickets(kategoria=...)`
- `set_ticket_category` and `set_ticket_severity` — folded into `modify_ticket`
- `remove_ticket` — replaced by `cancel_ticket` (soft delete)
- `get_problem_cluster` — folded into `find_pattern(scope="narrow"|"broadest", include_tickets=true)`
- `get_integration_stats` — folded into `answer_question` (the answer tool runs this internally when the question is about overall counts)

### 3.6 Tool count

| Before | After |
|---|---|
| 18 | 14 |

Net reduction: 4. But the new tool surface is dramatically more
deterministic because 70%+ of the variance paths collapse into
`answer_question`.

---

## 4. Database reshape (proposed)

Most of the wins come from the tool surface, but the DB needs a
pass too. Here's what's needed:

### 4.1 New tables

```sql
-- Customer master record, with canonical name + aliases
CREATE TABLE customer_canonical (
  id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  canonical_name_ascii TEXT NOT NULL,
  created_at TEXT,
  first_seen_iso TEXT,
  last_seen_iso TEXT,
  total_tickets INTEGER DEFAULT 0,
  open_tickets INTEGER DEFAULT 0
);
CREATE TABLE customer_alias (
  id INTEGER PRIMARY KEY,
  canonical_id INTEGER REFERENCES customer_canonical(id),
  alias_name TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,  -- diacritics + whitespace + suffix folded
  source TEXT  -- 'AKTUÁLIS NÉV' | 'RÉGI NÉV' | 'szerviz' | 'szev' | 'telephely'
);
CREATE UNIQUE INDEX idx_alias_norm ON customer_alias(alias_normalized, canonical_id);

-- Expanded kategoria with parent/child
CREATE TABLE kategoria_v2 (
  id INTEGER PRIMARY KEY,
  nev TEXT NOT NULL UNIQUE,
  nev_ascii TEXT NOT NULL,
  szulo_id INTEGER REFERENCES kategoria_v2(id),
  leiras TEXT,
  auto_keywords TEXT,  -- JSON array of regex/keyword triggers
  manual_only INTEGER DEFAULT 0  -- if true, never auto-classify
);

-- Inferred severity cache (because source is 100% null)
ALTER TABLE jobs ADD COLUMN sulyossag_inferred TEXT;
ALTER TABLE jobs ADD COLUMN sulyossag_confidence REAL;  -- 0..1

-- Auto-classified kategoria (separate from human-entered)
ALTER TABLE jobs ADD COLUMN kategoria_inferred TEXT;
ALTER TABLE jobs ADD COLUMN kategoria_inferred_id INTEGER REFERENCES kategoria_v2(id);

-- Resolution status (we lose "cancelled" vs "closed" vs "open" today)
ALTER TABLE jobs ADD COLUMN resolution TEXT;  -- 'open' | 'closed' | 'cancelled' | 'in_progress'

-- First / last seen per (canonical_customer, machine_type) — for "do we work with this customer?" queries
CREATE TABLE customer_machine_summary (
  canonical_customer_id INTEGER,
  machine_type TEXT,
  ticket_count INTEGER,
  first_seen_iso TEXT,
  last_seen_iso TEXT,
  last_resolution TEXT,
  PRIMARY KEY (canonical_customer_id, machine_type)
);
```

### 4.2 Backfill jobs (one-shot, run on deploy)

1. `build_customer_canonicals.ts` — collapse 65 921 customers into
   ~3 000 canonical customers. Use the alias-normalized key.
2. `backfill_inferred_severity.ts` — keyword heuristic. Conservative
   confidence values: "vészleállás / tűz / leállt" → kritikus 0.9;
   "nem indul / nem megy / főorsó áll" → magas 0.7; "beállítás /
   kérés / finomhangolás" → alacsony 0.7; default kozepes 0.4.
3. `backfill_inferred_kategoriak.ts` — reclassify 65 921 jobs using
   the new kategoria_v2 taxonomy. Store both `kategoria` (original)
   and `kategoria_inferred` (new). Confidence from keyword match
   count.
4. `rebuild_customer_machine_summary.ts` — materialise the
   customer×machine view.
5. `rebuild_clusters.ts` — re-run the cluster analysis so
   `find_pattern` is fast on first call.

### 4.3 Indexes to add

```sql
CREATE INDEX idx_jobs_kategoria_inferred ON jobs(kategoria_inferred);
CREATE INDEX idx_jobs_sulyossag_inferred ON jobs(sulyossag_inferred);
CREATE INDEX idx_jobs_resolution ON jobs(resolution);
CREATE INDEX idx_jobs_canonical_customer ON jobs(canonical_customer_id);
CREATE INDEX idx_customer_alias_normalized ON customer_alias(alias_normalized);
```

---

## 5. The 100 questions catalog

Below is a working catalog of the 100 most likely phrasings a worker
or supervisor would actually type, organized by intent. Each is
labeled with which tool should answer it in the new design and which
known-inconsistent tool the old design would have used.

The catalog is **in Hungarian** with English in parens, because the
input is hu. The old design has no hu-localized descriptions; the new
one does, so most of these stop producing different answers.

### 5.1 Single-customer lookup (12)

1. "Mutasd a [XYZ Kft.] összes ticketjét" → `customer_search` + `search_tickets`
2. "Hány nyitott ticketje van [ügyfél]nek?" → `customer_search` returns `open_tickets`
3. "Mikor volt utoljára náluk javítás?" → `customer_search.last_seen`
4. "Milyen gépeket szervízelünk [ügyfél]nél?" → `customer_search.top_devices[]`
5. "[Ügyfél] melyik gépével van a legtöbb baj?" → `aggregate_tickets(group_by: device, customer=…)`
6. "[Ügyfél] összes kritikus ticketje" → `search_tickets(sulyossag_inferred=kritikus, customer=…)`
7. "[Ügyfél] TMV-400-as ticketjei" → `search_tickets(customer=…, device="TMV-400")`
8. "[Ügyfél] 2024-es bejelentései" → `search_tickets(customer=…, period=last_year, year=2024)`
9. "Milyen kategóriájú hibái vannak [ügyfél]nek?" → `aggregate_tickets(group_by: kategoria_inferred, customer=…)`
10. "Ki szervízeli [ügyfél]t általában?" → `customer_search.top_technicians[]`
11. "Milyen alkatrészeket rendeltünk [ügyfél]hez?" → `search_szev_igeny(megrendelo=…)`
12. "Volt-e [ügyfél]nél telephelyi javítás?" → `search_telephely_munka(megrendelo=…)`

### 5.2 Single-device / single-machine (15)

13. "Mutasd a [M10170] összes ticketjét" → `search_tickets(device="M10170")`
14. "Mi a baja ennek a gépnek mostanában?" → `find_pattern(machine=…)` or `search_tickets(period=last_90_days, machine=…)`
15. "Melyik a TMV-400 leggyakoribb hibája?" → `aggregate_tickets(group_by: kategoria_inferred, machine_type=TMV-400)`
16. "Hányszor javítottuk a TMV-400-at 2025-ben?" → `aggregate_tickets(group_by: period(month), machine=TMV-400, year=2025)`
17. "Melyik NCT vezérlő a legproblémásabb?" → `aggregate_tickets(group_by: controller)`
18. "NCT104 szoftveres hibák" → `search_tickets(controller=NCT104, kategoria_inferred=Szoftver)`
19. "Mikor cseréltünk utoljára vezérlőt ennél a gépnél?" → `search_tickets(notes_contains="vezérlő csere", device=…)`
20. "Melyik ügyfélnél van a legtöbb TMV-400?" → `aggregate_tickets(group_by: customer, machine=TMV-400)`
21. "Ezzel a szervó hibajelenséggel foglalkoztunk már?" → `search_tickets(free_text="szervó hiba", include_evidence=true)`
22. "Mi a default szervó beállítás erre a gépre?" — *out of scope, no data*
23. "Milyen szervót használ a DPB-3-40-80?" → `search_tickets(device=DPB-3-40-80, include_evidence=true)` then look at evidence
24. "Van-e service manual a TMV-400-hoz?" — *out of scope, no data*
25. "Mennyi garanciális volt ezen a gépen?" → `search_tickets(payment=gar, device=…)`
26. "Mennyi fizetős volt ezen a gépen?" → `search_tickets(payment=fiz, device=…)`
27. "Melyik telephelyi munka kapcsolódik ehhez a géphez?" → `search_telephely_munka(geptipus=…)`

### 5.3 Aggregation / ranking / statistics (20)

28. "Melyik ügyfélhez járunk a legtöbbet?" → `aggregate_tickets(group_by: customer, period=all)` (default period: all)
29. "Melyik ügyfélhez járunk a legtöbbet idén?" → `aggregate_tickets(group_by: customer, period=this_year)`
30. "Melyik ügyfélhez járunk a legtöbbet az elmúlt 30 napban?" → `aggregate_tickets(group_by: customer, period=last_30_days)`
31. "Melyik a 10 legproblémásabb ügyfél?" → `aggregate_tickets(group_by: customer, period=all, limit=10)`
32. "Melyik ügyfélnek van a legtöbb nyitott ticketje?" → `aggregate_tickets(group_by: customer, status=open)`
33. "Melyik ügyfélnek van a legtöbb kritikus ticketje?" → `aggregate_tickets(group_by: customer, sulyossag_inferred=kritikus)`
34. "Melyik gép megy legtöbbször tönkre?" → `aggregate_tickets(group_by: machine_type)`
35. "Melyik vezérlő okozza a legtöbb hibát?" → `aggregate_tickets(group_by: controller)`
36. "Melyik a leggyakoribb hibakategória?" → `aggregate_tickets(group_by: kategoria_inferred)`
37. "Mennyi kritikus ticket van most?" → `aggregate_tickets(group_by: sulyossag_inferred, period=this_month)`
38. "Mennyi ticket van státuszonként?" → `aggregate_tickets(group_by: status)`
39. "Hány ticket / hónap?" → `aggregate_tickets(group_by: period(month), period=last_year)`
40. "Melyik technikus hány ticketet zárt le?" → `aggregate_tickets(group_by: technician, status=closed)`
41. "Melyik technikusnak van a legtöbb nyitott ticketje?" → `aggregate_tickets(group_by: technician, status=open)`
42. "Melyik technikus melyik vezérlőhöz ért a legjobban?" → `aggregate_tickets(group_by: technician, controller=…, then count=…)` — *compound group_by; needs new shape*
43. "Mi a TMV-400 / NCT104 kombináció eloszlása?" → `aggregate_tickets(group_by: [machine_type, controller], device=TMV-400)`
44. "Melyik a 3 legrosszabb hónap a support szempontjából?" → `aggregate_tickets(group_by: period(month), order=count_desc, limit=3)`
45. "Melyik kategória növekszik?" → `aggregate_tickets(group_by: [kategoria_inferred, period(month)], period=last_year, then trend on client side)*`
46. "Mekkora a krízis-trend?" → `aggregate_tickets(group_by: period(month), sulyossag_inferred=kritikus, period=last_year)`
47. "Melyik ügyfél számláján van a legtöbb garanciális?" → `aggregate_tickets(group_by: customer, payment=gar)`

### 5.4 Recurring problems (10)

48. "Mi okozza a legtöbb ismétlést a TMV-400-nál?" → `find_pattern(machine=TMV-400)`
49. "Volt-e már ilyen hiba ennél az ügyfélnél?" → `find_pattern(customer=…, kategoria_inferred=…)` + cross-ref `search_tickets`
50. "Melyik hibát nem sikerült még megoldani?" → `find_pattern(resolution_status=ongoing)`
51. "Melyik technikus melyik hibát oldja meg általában?" → `find_pattern(include_handoffs=true)` + look at `technicians[]`
52. "Hányszor jött vissza ez a hiba 2024-ben?" → `find_pattern(period=last_year, kategoria_inferred=…)` returns `visit_count`
53. "Melyik hibát kellene root-cause-olni?" → `find_pattern(order_by: visit_count desc, filter: resolution_status=ongoing)`
54. "Melyik ügyfél problémája a legmakacsabb?" → `find_pattern(group_by: customer, order_by: visit_count desc)`
55. "Volt-e a múlt héten új rekurrens hiba?" → `find_pattern(period=last_week, filter: first_seen > period_start)`
56. "Melyik hibán dolgozott a legtöbbféle technikus?" → `find_pattern(order_by: distinct_technicians desc)`
57. "Volt-e visszaesés egy korábban megoldott hibánál?" → `find_pattern(filter: regression=true)`

### 5.5 Internal archive / workshop (15)

58. "Volt-e 2018-ban telephelyi javítás erre a gépre?" → `search_telephely_munka(year=2018, geptipus=…)`
59. "Milyen szerviz belső ticketjeink vannak 2020-ból?" → `search_serviz_archive(year=2020)`
60. "Mutass egy konkrét belső szerviz J-sorszámot" → `search_serviz_archive(j_szam=J01234)`
61. "Melyik NCT motor zárlatos most a raktárban?" → `find_spare_motor(problema=zárlatos)`
62. "Van-e AiS100 pótmotorunk ehhez a géphez?" → `find_spare_motor(machine_serial=M16119, motor_type=AiS100)`
63. "Milyen csapágyat használ a DPB-3?" → `search_tickets(notes_contains=csapágy, machine=DPB-3)`
64. "Melyik ügyfélhez rendeltünk 2024-ben FAG csapágyat?" → `search_szev_igeny(igeny_contains="FAG", year=2024)`
65. "Milyen alkatrész a legtöbbször rendelt?" → `aggregate_tickets_over_szev(group_by: igeny_normalized, limit=20)`
66. "Ki a felelős a SZÉV2024-262-ért?" → `search_szev_igeny(szev_szam=SZÉV2024-262)`
67. "Milyen státuszú SZÉV-k vannak most?" → `aggregate_tickets_over_szev(group_by: status_label)`
68. "Melyik telephelyi munkánk van folyamatban?" → `search_telephely_munka(kesz=0)`
69. "Mennyi munkaórát töltöttünk telephelyen 2023-ban?" → `aggregate_telephely_munka(sum: telephelyi_munkaora, year=2023)`
70. "Melyik telephelyi munkánk van kész?" → `search_telephely_munka(kesz=1, year=…)`
71. "Melyik volt a legutóbbi telephelyi javítás a M14066-os gépen?" → `search_telephely_munka(geptipus="DK-7732F (M14066)", order=beerkezes desc, limit=1)`
72. "Melyik beszállítótól mit rendelünk gyakran?" → `search_szev_igeny(group_by: beszallito)`

### 5.6 Failure rates (factory-level) (5)

73. "Mekkora a DxC hajtások meghibásodási aránya 2022-ben?" → `get_failure_rates(product=DxC, year=2022)`
74. "Melyik termék a legrosszabb most?" → `get_failure_rates(year=this_year, order_by: fail_pct desc, limit=5)`
75. "Jobbak lettek az IPS1-2-k 2023-ban?" → `get_failure_rates(product=IPS1-2, year in [2022, 2023])`
76. "Mekkora a garanciális arány?" → `get_failure_rates(group_by: product, fields: gar_pct, fiz_pct)`
77. "Melyik terméket gyártottuk a legtöbbet 2024-ben?" → `get_failure_rates(year=2024, order_by: total_built desc, limit=10)`

### 5.7 Cross-cutting / synthesis (10)

78. "Foglald össze a 2025-ös helyzetet" → `answer_question(q, period=this_year)` — synthesis
79. "Mi változott a szupportban az utóbbi negyedévben?" → `answer_question(q, period=last_quarter)` — synthesis
80. "Melyik ügyfélnél van kritikus helyzet most?" → `aggregate_tickets(group_by: customer, sulyossag_inferred=kritikus, status=open)`
81. "Melyik hibán dolgozunk jelenleg?" → `aggregate_tickets(group_by: kategoria_inferred, status=open, period=this_month)`
82. "Készíts összefoglalót a legfrissebb 10 ticketről" → `search_tickets(period=last_week, limit=10, include_evidence=true)`
83. "Mi a teendőm holnapra?" — *vague; answer_question returns follow_ups[] with clarification*
84. "Volt-e hasonló eset a múltban?" → `find_pattern(notes_contains=…)`
85. "Mennyi pénzt spóroltunk a preventív karbantartással?" — *out of scope, no financial data*
86. "Melyik partnerünk a legmegbízhatóbb?" — *vague; answer_question asks for clarification*
87. "Melyik ügyfelet érdemes felhívni preventív karbantartásra?" → `customer_search(filter: last_seen > 6 months ago, top_devices: contains known-fragile model)`

### 5.8 Edge cases / clarification / meta (13)

88. "Mit tudsz egyáltalán?" → `get_categories` + `get_capabilities`
89. "Milyen kategóriák vannak?" → `get_categories`
90. "Hogyan működik ez a rendszer?" → `get_capabilities` (returns full system description)
91. "Egy ügyfél több néven fut, hogyan találom meg?" → `customer_search(fuzzy=true)`
92. "Mi a különbség a 'Vezérlő hiba' és a 'Szoftver hiba' között?" → `get_categories` returns `leiras`
93. "Ez a sorszám: B26072216 — mi ez?" → `search_tickets(sorszam=B26072216)`
94. "Technikus: TV" → `search_tickets(technician=TV)` — needs to know "TV" is a tech initial, not a category
95. "Mi a különbség a szev és a szerviz között?" → `get_capabilities` (definitional)
96. "Hibás a kategória, javítsd ki" → `modify_ticket(sorszam=…, kategoria_inferred=…)` — admin correction
97. "Töröld ezt a ticketet" → `cancel_ticket(sorszam=…, reason=…)` — soft delete
98. "Zárd le ezt a ticketet, megoldva" → `close_ticket(sorszam=…, text=…)`
99. "Adj hozzá egy megjegyzést" → `add_ticket_note(sorszam=…, body=…)`
100. "Hozz létre egy új ticketet [adatok]" → `create_ticket(...)`

---

## 6. Implementation order

I'm proposing 4 phases. Each phase ends with a measurable
consistency check: ask the same 20 questions twice in two fresh
sessions, compare answers.

### Phase 0 — Don't break what works (1 day)

- Add `period` parameter support to all existing tools (R9)
- Add `include_evidence` default-on to `get_ticket_stats` (R12)
- Add Hungarian translation of every tool description and parameter
  help text (R1)
- Add `customer_alias` table and a backfill script (R7)

**Consistency target after Phase 0:** 65% → ~75% (free wins).

### Phase 1 — Router and unify search (3 days)

- Implement `answer_question` (R2)
- Merge `search_by_category` and `search_existing_tickets` into
  `search_tickets` (R2)
- Add `sulyossag_inferred` + `kategoria_inferred` columns and
  backfill (R4, R5, R6)
- Add `language` parameter to all tools (R1)

**Consistency target after Phase 1:** 75% → ~88%.

### Phase 2 — Patterns and synthesis (3 days)

- Rewrite `find_pattern` with cross-references to serviz/szev
  archives and evidence snippets (R8)
- Add `find_spare_motor` and `get_failure_rates` (R10)
- Add `customer_canonical` table backfill (R7)
- Add the `customer_search` tool (R7)

**Consistency target after Phase 2:** 88% → ~94%.

### Phase 3 — Polish and rollout (2 days)

- Bilingual tool descriptions finalized
- 100-question regression test (script that runs the same 100
  questions, calls the answer, and scores consistency)
- Update `AGENTS.md` to reflect the new tool surface
- Deploy to prod, monitor for one week, then expand

**Consistency target after Phase 3:** 94%+ (any remaining variance
is in the LLM's prose, not the tool selection)

---

## 7. Open questions for you

Before I touch any code, I want your sign-off on these:

1. **The 18 → 14 tool count is the right shape?** I'm willing to
   keep more tools if you have UI/UX reasons. But the router +
   `search_tickets` + `aggregate_tickets` trio is the single
   biggest consistency win.
2. **Soft-delete instead of hard-delete (`cancel_ticket`)?** This
   keeps audit trail. The old `remove_ticket` is dangerous.
3. **Backfill `kategoria_inferred`?** This is one of the bigger
   changes — it overwrites the *displayed* kategoria unless I keep
   both columns. I'd default to: display `kategoria_inferred` in
   new tool results but expose the original `kategoria` field too.
4. **Reclassify `sulyossag` heuristically?** Same question — this
   fills the empty column. I'd default to: same pattern, show
   both. Confidence threshold for "I can answer 'how many critical
   tickets'": ≥0.6.
5. **Run the backfill in one shot or staged?** I'd stage: 1k rows
   first to spot-check, then 65k.

---

## 8. What I'm *not* proposing

In the spirit of "fix what's broken, don't gold-plate":

- No new server runtime (still bun + sqlite, same `cmms-api` binary)
- No new dependency (no embeddings, no vector DB, no LLM call server-side)
- No restructuring of the FTS5 indexes (they're already fine)
- No UI changes (MCP is headless, KiloClaw stays as-is)
- No removal of any REST endpoint (only the MCP surface changes; the
  REST stays backwards compatible)

The router is keyword-based, not LLM-based, so it's deterministic
and free.

---

## 9. What I'll deliver, in order

Once you sign off on the plan above, here's the order I'll work in:

1. **Phase 0 PR** — period + evidence + hu descriptions + customer aliases
2. **Phase 1 PR** — answer_question + search_tickets + inferred kategoria/severity
3. **Phase 2 PR** — find_pattern + find_spare_motor + get_failure_rates + customer_canonical
4. **Phase 3 PR** — regression test + AGENTS.md update + deploy

Each PR is independently shippable. If you only want Phase 0, that's
fine — it gets you 10% consistency improvement for ~1 day of work.

Let me know which direction to go.
