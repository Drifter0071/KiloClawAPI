// _check-m09192-deep.ts - exhaustive search for any note mentioning M09192 + golyos/csapagy/etc
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'cat > /tmp/q9.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "const db = new Database('/var/lib/cmms/cmms_specialized.db')",
      "// 1. Find every job_key that has a device whose raw_type/freeform contains M09192",
      "const jobKeys = new Set<number>()",
      "const devs = db.query(\"SELECT job_key, raw_type, freeform FROM devices WHERE raw_type LIKE '%M09192%' OR freeform LIKE '%M09192%' OR raw_type LIKE '%M:09192%' OR raw_type LIKE '%m:09192%'\").all() as any[]",
      "console.log('Devices matching M09192:', devs.length)",
      "for (const d of devs) {",
      "  jobKeys.add(d.job_key)",
      "  console.log('  job_key=' + d.job_key, '|', d.raw_type.slice(0, 80))",
      "}",
      "// 2. Find every note that mentions M09192",
      "const notes = db.query(\"SELECT job_key, kind, body FROM notes WHERE body LIKE '%M09192%' OR body LIKE '%M:09192%' OR body LIKE '%m09192%'\").all() as any[]",
      "console.log('\\nNotes matching M09192:', notes.length)",
      "for (const n of notes) {",
      "  jobKeys.add(n.job_key)",
      "  console.log('  job_key=' + n.job_key, 'kind=' + n.kind)",
      "  console.log('    body:', n.body.slice(0, 300))",
      "}",
      "// 3. Also: find every job_key whose sorszam or anything 5-digit contains 09192",
      "const allJobs = db.query(\"SELECT key, sorszam, customer_id, problem_kategoria, problem_alkategoria, sulyossag, kategoria_inferred FROM jobs\").all() as any[]",
      "console.log('\\nTotal jobs:', allJobs.length)",
      "// 4. For every job in the set, list all notes",
      "console.log('\\nAll notes for matched job_keys:')",
      "for (const jk of jobKeys) {",
      "  const jn = allJobs.find(j => j.key === jk)",
      "  const ns = db.query(\"SELECT kind, body FROM notes WHERE job_key = ?\").all(jk) as any[]",
      "  console.log('\\nJOB key=' + jk, jn ? 'sorszam=' + jn.sorszam : 'no sorszam', jn ? 'kategoria=' + jn.kategoria_inferred : '')",
      "  for (const n of ns) console.log('  ' + n.kind + ':', n.body.slice(0, 400))",
      "}",
      "db.close()",
      "TS",
      'bun run /tmp/q9.ts 2>&1 | head -200',
    ].join('\n'),
    (e, stream) => {
      if (e) { console.error(e); c.end(); return }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => { console.log(out); c.end() })
    },
  )
})
c.on('error', (e) => console.error('conn error', e))
c.connect({ host: '10.0.3.81', port: 22, username: 'root', password: 'tarantula999' })
