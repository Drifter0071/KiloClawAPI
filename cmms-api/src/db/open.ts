// Dual SQLite connections via bun:sqlite (works on Windows dev + Debian target).
//
// Two files:
//   - CMMS_DB_PATH:        the original cmms.db (read + write, but the human
//                          CMMS app owns it; we serialize our writes)
//   - CMMS_SPECIALIZED_DB: a sidecar that holds customers / devices /
//                          jobs / notes / _meta, derived from cmms.db
//
// We open both connections, apply PRAGMAs, and expose prepared statements.

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export type OpenDbs = {
  cmmsPath: string;
  specializedPath: string;
  cmms: Database;
  spec: Database;
  // prepared statements on the specialized DB
  stmts: {
    insertCustomer: ReturnType<Database["prepare"]>;
    insertDevice: ReturnType<Database["prepare"]>;
    insertJob: ReturnType<Database["prepare"]>;
    insertNote: ReturnType<Database["prepare"]>;
    setMeta: ReturnType<Database["prepare"]>;
    getMeta: ReturnType<Database["prepare"]>;
    updateJobInferred: ReturnType<Database["prepare"]>;
    maxKey: ReturnType<Database["prepare"]>;
    sorszamForMonth: ReturnType<Database["prepare"]>;
    maxSorszam: ReturnType<Database["prepare"]>;
    sorszamExists: ReturnType<Database["prepare"]>;
    insertProblemaKategoria: ReturnType<Database["prepare"]>;
    getProblemaKategoriaById: ReturnType<Database["prepare"]>;
    getProblemaKategoriaByName: ReturnType<Database["prepare"]>;
    getAllProblemaKategoriak: ReturnType<Database["prepare"]>;
    insertProblemaCimke: ReturnType<Database["prepare"]>;
    getProblemaCimkeByName: ReturnType<Database["prepare"]>;
    getAllProblemaCimkek: ReturnType<Database["prepare"]>;
    linkTicketProblema: ReturnType<Database["prepare"]>;
    unlinkTicketProblema: ReturnType<Database["prepare"]>;
    getTicketProblemaKategoriak: ReturnType<Database["prepare"]>;
    linkTicketCimke: ReturnType<Database["prepare"]>;
    unlinkTicketCimke: ReturnType<Database["prepare"]>;
    getTicketCimkek: ReturnType<Database["prepare"]>;
    insertFeedbackAnswer: ReturnType<Database["prepare"]>;
    getFeedbackAnswer: ReturnType<Database["prepare"]>;
    /** Full row, used by the share-link endpoint. */
    getFeedbackAnswerFull: ReturnType<Database["prepare"]>;
    insertFeedbackVote: ReturnType<Database["prepare"]>;
    getFeedbackVote: ReturnType<Database["prepare"]>;
    upsertFeedbackVote: ReturnType<Database["prepare"]>;
    deleteFeedbackVote: ReturnType<Database["prepare"]>;
    getFeedbackVotesForUid: ReturnType<Database["prepare"]>;
    getFeedbackCounters: ReturnType<Database["prepare"]>;
    insertFeedbackCorrection: ReturnType<Database["prepare"]>;
    getFeedbackCorrectionForUid: ReturnType<Database["prepare"]>;
    getFeedbackCorrectionsForAnswer: ReturnType<Database["prepare"]>;
    getFeedbackCorrectionsForUid: ReturnType<Database["prepare"]>;
    listDislikedFeedback: ReturnType<Database["prepare"]>;
    listDislikedFeedbackWithCorrection: ReturnType<Database["prepare"]>;
    countDislikedFeedback: ReturnType<Database["prepare"]>;
    clearAll: () => void;
  };
};

// Schema is split into two parts: tables first (so the new column
// migrations can add problem_kategoria/sulyossag/controller/machine_type
// without conflict), then indexes and seed data. This makes openDbs()
// safe to call against a database that already has a partial schema.

// Part 1: tables only (no indexes that reference later-added columns).
const SCHEMA_TABLES_ONLY = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_ascii TEXT NOT NULL,
  zip TEXT,
  address TEXT,
  address_ascii TEXT,
  phone TEXT,
  email TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  key INTEGER PRIMARY KEY,
  sorszam TEXT NOT NULL UNIQUE,
  reported_at TEXT,
  reported_at_iso TEXT,
  customer_id INTEGER REFERENCES customers(id),
  technician TEXT,
  -- status polarity (Phase 3 fix): 0=closed (lezárt), 1=open (nyitott).
  status INTEGER NOT NULL DEFAULT 1,
  problem_kategoria TEXT,
  problem_alkategoria TEXT,
  sulyossag TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key INTEGER NOT NULL REFERENCES jobs(key) ON DELETE CASCADE,
  raw_type TEXT NOT NULL,
  raw_type_ascii TEXT NOT NULL,
  model TEXT,
  model_ascii TEXT,
  software TEXT,
  hardware TEXT,
  servos TEXT,
  controller TEXT,
  machine_type TEXT,
  freeform TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key INTEGER NOT NULL REFERENCES jobs(key) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reported','work','free')),
  body TEXT NOT NULL,
  body_ascii TEXT NOT NULL,
  author TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS problema_kategoriak (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nev TEXT NOT NULL UNIQUE,
  nev_ascii TEXT NOT NULL,
  szulo_id INTEGER REFERENCES problema_kategoriak(id),
  leiras TEXT
);

CREATE TABLE IF NOT EXISTS problema_cimkek (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nev TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ticket_problema (
  ticket_key INTEGER NOT NULL REFERENCES jobs(key) ON DELETE CASCADE,
  problema_id INTEGER NOT NULL REFERENCES problema_kategoriak(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_key, problema_id)
);

CREATE TABLE IF NOT EXISTS ticket_cimkek (
  ticket_key INTEGER NOT NULL REFERENCES jobs(key) ON DELETE CASCADE,
  cimke_id INTEGER NOT NULL REFERENCES problema_cimkek(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_key, cimke_id)
);

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Ask feedback (like / dislike). Two tables:
--   feedback_answers: one row per assistant answer the user can vote on.
--   feedback_votes:   one row per (answer, anonymous uid). vote is -1 or 1.
-- Counter is COUNT(*) over feedback_votes (no materialized stats table).
CREATE TABLE IF NOT EXISTS feedback_answers (
  answer_id    TEXT PRIMARY KEY,
  q            TEXT NOT NULL,
  final_text   TEXT NOT NULL,
  tool_trace   TEXT NOT NULL,
  model        TEXT NOT NULL,
  iterations   INTEGER NOT NULL,
  language     TEXT NOT NULL,
  resolved_customer TEXT,
  ticket_cards TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_votes (
  answer_id  TEXT NOT NULL REFERENCES feedback_answers(answer_id) ON DELETE CASCADE,
  uid        TEXT NOT NULL,
  vote       INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  reason     TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (answer_id, uid)
);

-- "What the answer should have been" — user-submitted free text.
-- (answer_id, uid) PK = latest wins (UPSERT).
CREATE TABLE IF NOT EXISTS feedback_corrections (
  answer_id  TEXT NOT NULL REFERENCES feedback_answers(answer_id) ON DELETE CASCADE,
  uid        TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (answer_id, uid)
);

-- Web Push subscriptions (Phase 8, 2026-08-24, F2 in the brainstorm).
-- Each row is one (uid, endpoint) pair — the user can have multiple
-- devices (desktop + Android), each with its own subscription. We
-- store the raw Web Push payload so the server can forward messages
-- via web-push without re-deriving the keys per call.
--
-- The "endpoint" column is unique because RFC 8030 mandates that the
-- same (endpoint, keys) pair is stable; re-subscribing on the same
-- device just updates the existing row. "uid" is indexed so the
-- notification sender can do a fast "all devices for this user"
-- lookup.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT
);
`;

// Part 2: indexes + seed data. Safe to re-run (CREATE INDEX IF NOT EXISTS).
const SCHEMA_INDEXES_AND_SEED = `
CREATE INDEX IF NOT EXISTS idx_customers_name_ascii ON customers(name_ascii);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_reported_at_iso ON jobs(reported_at_iso);
CREATE INDEX IF NOT EXISTS idx_jobs_problem_kategoria ON jobs(problem_kategoria);
CREATE INDEX IF NOT EXISTS idx_jobs_sulyossag ON jobs(sulyossag);

CREATE INDEX IF NOT EXISTS idx_devices_model_ascii ON devices(model_ascii);
CREATE INDEX IF NOT EXISTS idx_devices_raw_ascii ON devices(raw_type_ascii);
CREATE INDEX IF NOT EXISTS idx_devices_controller ON devices(controller);
CREATE INDEX IF NOT EXISTS idx_devices_machine_type ON devices(machine_type);

CREATE INDEX IF NOT EXISTS idx_notes_body_ascii ON notes(body_ascii);
CREATE INDEX IF NOT EXISTS idx_problema_kategoriak_nev_ascii ON problema_kategoriak(nev_ascii);
CREATE INDEX IF NOT EXISTS idx_ticket_problema_problema ON ticket_problema(problema_id);
CREATE INDEX IF NOT EXISTS idx_ticket_cimkek_cimke ON ticket_cimkek(cimke_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_uid ON push_subscriptions(uid);

INSERT OR IGNORE INTO problema_kategoriak (nev, nev_ascii, leiras) VALUES
  ('Szoftver hiba', 'szoftver hiba', 'Programhibak, PLC program, frissites, verzio, licenc'),
  ('Hardver hiba', 'hardver hiba', 'Nyaktak, alaplap, proci, memoria, kijelzo hiba'),
  ('Arampitlasi hiba', 'aramellatasi hiba', 'Taplgep, feszultseg, biztositek, aramkimaradas'),
  ('Halozati hiba', 'halozati hiba', 'Internet, wifi, kabel, kapcsolat, halozat'),
  ('Mechanikai hiba', 'mechanikai hiba', 'Csapagyszij, lanchajtas, kopas, mechanikus serultseg'),
  ('Beallitasi hiba', 'beallitasi hiba', 'Kalibrallas, parameter, konfiguracio, regzalas'),
  ('Karbantartas', 'karbantartas', 'Tisztitas, kenes, ellenorzes, eloiras szerinti'),
  ('Telepites', 'telepites', 'Uzembehelyezes, telepites, atalakitas'),
  ('Kepzes', 'kepzes', 'Oktatas, kepzestamogatas, dokumentacio'),
  ('Egyeb', 'egyeb', 'Nem besorolhato kerdesek, egyeb problemak'),
  ('Tavoli eleres', 'tavoli eleres', 'Tavoli gepeles, VPN, remote desktop, TeamViewer'),
  ('Kijelzo hiba', 'kijelzo hiba', 'CRT, LCD, monitor, kijelzo problemas'),
  ('Csatlakozasi hiba', 'csatlakozasi hiba', 'Dugaszolas, csatlakozo, kabel, aljzat'),
  ('Vezérlő hiba', 'vezerlo hiba', 'PLC, NC vezérlő, vezérlő szoftver, programozás, tengelyvezérlés'),
  ('Géptípus hiba', 'geptipus hiba', 'Géptípushoz köthető specifikus hiba, konstrukciós probléma');
`;

export function openDbs(opts?: { cmmsPath?: string; specializedPath?: string }): OpenDbs {
  const cmmsPath = resolve(opts?.cmmsPath ?? process.env.CMMS_DB_PATH ?? "./cmms.db");
  const specializedPath = resolve(
    opts?.specializedPath ?? process.env.CMMS_SPECIALIZED_DB ?? "./cmms_specialized.db",
  );

  const cmms = new Database(cmmsPath);
  // We do write to cmms.db for new jobs / notes. WAL helps here.
  cmms.exec("PRAGMA journal_mode = WAL;");
  cmms.exec("PRAGMA synchronous = NORMAL;");
  cmms.exec("PRAGMA busy_timeout = 5000;");

  const spec = new Database(specializedPath, { create: true });
  spec.exec("PRAGMA journal_mode = WAL;");
  spec.exec("PRAGMA synchronous = NORMAL;");
  spec.exec("PRAGMA busy_timeout = 5000;");
  spec.exec("PRAGMA foreign_keys = ON;");

  // Create only the tables (no indexes yet). Indexes are added later
  // so that the migration step can add new columns first.
  spec.exec(SCHEMA_TABLES_ONLY);

  // Migrate existing databases: add new columns if they don't exist.
  // On a fresh DB these are no-ops because the new columns are part of
  // the CREATE TABLE above.
  const migrateJobColumns = [
    `ALTER TABLE jobs ADD COLUMN problem_kategoria TEXT`,
    `ALTER TABLE jobs ADD COLUMN problem_alkategoria TEXT`,
    `ALTER TABLE jobs ADD COLUMN sulyossag TEXT`,
    // Phase 1 (R4/R5/R6): inferred kategoria and severity live next
    // to the human-entered values. We never overwrite the original
    // columns — only fill the inferred ones.
    `ALTER TABLE jobs ADD COLUMN kategoria_inferred TEXT`,
    `ALTER TABLE jobs ADD COLUMN kategoria_inferred_conf REAL`,
    `ALTER TABLE jobs ADD COLUMN sulyossag_inferred TEXT`,
    `ALTER TABLE jobs ADD COLUMN sulyossag_inferred_conf REAL`,
    `ALTER TABLE jobs ADD COLUMN alkategoria_inferred TEXT`,
    `ALTER TABLE jobs ADD COLUMN resolution TEXT`,
  ];
  for (const sql of migrateJobColumns) {
    try { spec.exec(sql); } catch { /* column already exists */ }
  }
  try { spec.exec(`ALTER TABLE devices ADD COLUMN controller TEXT`); } catch {}
  try { spec.exec(`ALTER TABLE devices ADD COLUMN machine_type TEXT`); } catch {}

  // Indexes on the new inferred columns. CREATE INDEX IF NOT EXISTS
  // is safe on the schema; here we guard with try/catch to keep the
  // migration block uniform with the column migrations above.
  const newIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_jobs_kategoria_inferred ON jobs(kategoria_inferred)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_sulyossag_inferred ON jobs(sulyossag_inferred)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_resolution ON jobs(resolution)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_alkategoria_inferred ON jobs(alkategoria_inferred)`,
  ];
  for (const sql of newIndexes) {
    try { spec.exec(sql); } catch { /* already exists */ }
  }

  // Index on notes(job_key, kind) — the backfill in db/backfill.ts
  // (and many other places) filter notes by job_key + kind, and without
  // this index each lookup is a full table scan. With 100k notes and
  // 65k jobs, a missing index turns a 1s query into a 30+ minute hang.
  // See the cmms-mcp-redesign Phase 1 bug report for context.
  try { spec.exec(`CREATE INDEX IF NOT EXISTS idx_notes_job_kind ON notes(job_key, kind)`); } catch {}

  // Now add the indexes (and seed data). CREATE INDEX IF NOT EXISTS
  // makes this safe to re-run.
  spec.exec(SCHEMA_INDEXES_AND_SEED);

  const clearAll = spec.transaction(() => {
    spec.exec("DELETE FROM ticket_cimkek");
    spec.exec("DELETE FROM ticket_problema");
    spec.exec("DELETE FROM notes");
    spec.exec("DELETE FROM devices");
    spec.exec("DELETE FROM jobs");
    spec.exec("DELETE FROM customers");
    spec.exec("DELETE FROM feedback_votes");
    spec.exec("DELETE FROM feedback_corrections");
    spec.exec("DELETE FROM feedback_answers");
  });

  const stmts = {
    insertCustomer: spec.prepare(
      `INSERT INTO customers (name, name_ascii, zip, address, address_ascii, phone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         name_ascii=excluded.name_ascii,
         zip=excluded.zip,
         address=excluded.address,
         address_ascii=excluded.address_ascii,
         phone=excluded.phone,
         email=excluded.email`,
    ),
    insertDevice: spec.prepare(
      `INSERT INTO devices
         (job_key, raw_type, raw_type_ascii, model, model_ascii, software, hardware, servos, controller, machine_type, freeform)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertJob: spec.prepare(
      `INSERT INTO jobs (
         key, sorszam, reported_at, reported_at_iso, customer_id, technician, status,
         problem_kategoria, problem_alkategoria, sulyossag,
         kategoria_inferred, kategoria_inferred_conf,
         sulyossag_inferred, sulyossag_inferred_conf,
         alkategoria_inferred, resolution
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         sorszam=excluded.sorszam,
         reported_at=excluded.reported_at,
         reported_at_iso=excluded.reported_at_iso,
         customer_id=excluded.customer_id,
         technician=excluded.technician,
         status=excluded.status,
         problem_kategoria=excluded.problem_kategoria,
         problem_alkategoria=excluded.problem_alkategoria,
         sulyossag=excluded.sulyossag,
         kategoria_inferred=excluded.kategoria_inferred,
         kategoria_inferred_conf=excluded.kategoria_inferred_conf,
         sulyossag_inferred=excluded.sulyossag_inferred,
         sulyossag_inferred_conf=excluded.sulyossag_inferred_conf,
         alkategoria_inferred=excluded.alkategoria_inferred,
         resolution=COALESCE(excluded.resolution, jobs.resolution)`,
    ),
    insertNote: spec.prepare(
      `INSERT INTO notes (job_key, kind, body, body_ascii, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    setMeta: spec.prepare(`INSERT INTO _meta (key, value) VALUES (?, ?)
                           ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
    getMeta: spec.prepare(`SELECT value FROM _meta WHERE key = ?`),
    updateJobInferred: spec.prepare(
      `UPDATE jobs SET
         kategoria_inferred = ?,
         kategoria_inferred_conf = ?,
         sulyossag_inferred = ?,
         sulyossag_inferred_conf = ?,
         alkategoria_inferred = ?
       WHERE key = ?`,
    ),
    maxKey: spec.prepare(`SELECT COALESCE(MAX(key), 0) AS m FROM jobs`),
    sorszamForMonth: spec.prepare(
      `SELECT sorszam FROM jobs WHERE sorszam LIKE ? ORDER BY sorszam DESC LIMIT 1`,
    ),
    maxSorszam: spec.prepare(`SELECT sorszam FROM jobs ORDER BY sorszam DESC LIMIT 1`),
    sorszamExists: spec.prepare(`SELECT 1 AS x FROM jobs WHERE sorszam = ? LIMIT 1`),
    insertProblemaKategoria: spec.prepare(
      `INSERT INTO problema_kategoriak (nev, nev_ascii, leiras) VALUES (?, ?, ?)
       ON CONFLICT(nev) DO UPDATE SET leiras=excluded.leiras RETURNING id`,
    ),
    getProblemaKategoriaById: spec.prepare(`SELECT id, nev, nev_ascii, leiras FROM problema_kategoriak WHERE id = ?`),
    getProblemaKategoriaByName: spec.prepare(`SELECT id, nev, nev_ascii, leiras FROM problema_kategoriak WHERE nev = ?`),
    getAllProblemaKategoriak: spec.prepare(`SELECT id, nev, nev_ascii, leiras FROM problema_kategoriak ORDER BY nev`),
    insertProblemaCimke: spec.prepare(
      `INSERT INTO problema_cimkek (nev) VALUES (?)
       ON CONFLICT(nev) DO UPDATE SET nev=excluded.nev RETURNING id`,
    ),
    getProblemaCimkeByName: spec.prepare(`SELECT id, nev FROM problema_cimkek WHERE nev = ?`),
    getAllProblemaCimkek: spec.prepare(`SELECT id, nev FROM problema_cimkek ORDER BY nev`),
    linkTicketProblema: spec.prepare(
      `INSERT OR IGNORE INTO ticket_problema (ticket_key, problema_id) VALUES (?, ?)`,
    ),
    unlinkTicketProblema: spec.prepare(
      `DELETE FROM ticket_problema WHERE ticket_key = ? AND problema_id = ?`,
    ),
    getTicketProblemaKategoriak: spec.prepare(
      `SELECT pk.id, pk.nev FROM problema_kategoriak pk
       INNER JOIN ticket_problema tp ON tp.problema_id = pk.id
       WHERE tp.ticket_key = ? ORDER BY pk.nev`,
    ),
    linkTicketCimke: spec.prepare(
      `INSERT OR IGNORE INTO ticket_cimkek (ticket_key, cimke_id) VALUES (?, ?)`,
    ),
    unlinkTicketCimke: spec.prepare(
      `DELETE FROM ticket_cimkek WHERE ticket_key = ? AND cimke_id = ?`,
    ),
    getTicketCimkek: spec.prepare(
      `SELECT pc.id, pc.nev FROM problema_cimkek pc
       INNER JOIN ticket_cimkek tc ON tc.cimke_id = pc.id
       WHERE tc.ticket_key = ? ORDER BY pc.nev`,
    ),
    // feedback_answers: one row per assistant answer. The agent route
    // (src/routes/agent.ts) inserts a row each time it returns a final
    // answer so votes can reference it.
    insertFeedbackAnswer: spec.prepare(
      `INSERT INTO feedback_answers
         (answer_id, q, final_text, tool_trace, model, iterations, language,
          resolved_customer, ticket_cards, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(answer_id) DO UPDATE SET
         final_text=excluded.final_text,
         tool_trace=excluded.tool_trace`,
    ),
    getFeedbackAnswer: spec.prepare(
      `SELECT answer_id FROM feedback_answers WHERE answer_id = ?`,
    ),
    getFeedbackAnswerFull: spec.prepare(
      `SELECT answer_id, q, final_text, tool_trace, model, iterations, language, created_at
       FROM feedback_answers WHERE answer_id = ?`,
    ),
    insertFeedbackVote: spec.prepare(
      `INSERT INTO feedback_votes (answer_id, uid, vote, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(answer_id, uid) DO UPDATE SET
         vote=excluded.vote,
         reason=excluded.reason,
         created_at=excluded.created_at`,
    ),
    upsertFeedbackVote: spec.prepare(
      `INSERT INTO feedback_votes (answer_id, uid, vote, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(answer_id, uid) DO UPDATE SET
         vote=excluded.vote,
         reason=excluded.reason,
         created_at=excluded.created_at`,
    ),
    deleteFeedbackVote: spec.prepare(
      `DELETE FROM feedback_votes WHERE answer_id = ? AND uid = ?`,
    ),
    getFeedbackVote: spec.prepare(
      `SELECT vote, reason, created_at FROM feedback_votes
       WHERE answer_id = ? AND uid = ?`,
    ),
    getFeedbackVotesForUid: spec.prepare(
      `SELECT answer_id, vote, reason, created_at
       FROM feedback_votes
       WHERE uid = ? AND answer_id IN (SELECT value FROM json_each(?))`,
    ),
    getFeedbackCounters: spec.prepare(
      `SELECT
         (SELECT COUNT(*) FROM feedback_votes WHERE vote =  1) AS likes,
         (SELECT COUNT(*) FROM feedback_votes WHERE vote = -1) AS dislikes`,
    ),
    listDislikedFeedback: spec.prepare(
      `SELECT
         fa.answer_id, fa.q, fa.final_text, fa.tool_trace, fa.model,
         fa.iterations, fa.language, fa.resolved_customer, fa.ticket_cards,
         fa.created_at,
         fv.uid, fv.vote, fv.reason, fv.created_at AS vote_at
       FROM feedback_votes fv
       INNER JOIN feedback_answers fa ON fa.answer_id = fv.answer_id
       WHERE fv.vote = -1
       ORDER BY fv.created_at DESC
       LIMIT ? OFFSET ?`,
    ),
    countDislikedFeedback: spec.prepare(
      `SELECT COUNT(*) AS n FROM feedback_votes WHERE vote = -1`,
    ),
    insertFeedbackCorrection: spec.prepare(
      `INSERT INTO feedback_corrections (answer_id, uid, correction, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(answer_id, uid) DO UPDATE SET
         correction=excluded.correction,
         created_at=excluded.created_at`,
    ),
    getFeedbackCorrectionForUid: spec.prepare(
      `SELECT correction, created_at FROM feedback_corrections
       WHERE answer_id = ? AND uid = ?`,
    ),
    getFeedbackCorrectionsForAnswer: spec.prepare(
      `SELECT uid, correction, created_at FROM feedback_corrections
       WHERE answer_id = ?
       ORDER BY created_at DESC`,
    ),
    // Batched variant: given a JSON array of answer_ids, return this
    // uid's correction (latest one only) for each. Used by
    // GET /v1/feedback/my-corrections so the Ask page can hydrate
    // the "Visszajelzés elküldve" state for all rendered bubbles in
    // a single round-trip — same pattern as getFeedbackVotesForUid.
    getFeedbackCorrectionsForUid: spec.prepare(
      `SELECT answer_id, correction, created_at
         FROM feedback_corrections
        WHERE uid = ?
          AND answer_id IN (SELECT value FROM json_each(?))
        ORDER BY created_at DESC`,
    ),
    listDislikedFeedbackWithCorrection: spec.prepare(
      `SELECT
         fa.answer_id, fa.q, fa.final_text, fa.tool_trace, fa.model,
         fa.iterations, fa.language, fa.resolved_customer, fa.ticket_cards,
         fa.created_at,
         fv.uid AS vote_uid, fv.vote, fv.reason, fv.created_at AS vote_at,
         fc.uid AS correction_uid, fc.correction, fc.created_at AS correction_at,
         (SELECT COUNT(*) FROM feedback_corrections WHERE answer_id = fa.answer_id) AS correction_count
       FROM feedback_votes fv
       INNER JOIN feedback_answers fa ON fa.answer_id = fv.answer_id
       LEFT JOIN feedback_corrections fc
         ON fc.answer_id = fa.answer_id
         AND fc.created_at = (SELECT MAX(created_at) FROM feedback_corrections WHERE answer_id = fa.answer_id)
       WHERE fv.vote = -1
       ORDER BY fv.created_at DESC
       LIMIT ? OFFSET ?`,
    ),
    clearAll,
  };

  return { cmmsPath, specializedPath, cmms, spec, stmts };
}
