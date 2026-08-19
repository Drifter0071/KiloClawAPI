// _test-part-spec.ts - test the part_spec branch directly
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'cat > /tmp/qs.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "import { Database as DB2 } from 'bun:sqlite'",
      "import { fold } from './src/db/parse'",
      "const db = new DB2('/var/lib/cmms/cmms_specialized.db')",
      "const cards = db.query(\"SELECT j.sorszam, j.reported_at_iso, j.kategoria_inferred, c.name as cust FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id WHERE j.key IN (SELECT job_key FROM devices WHERE raw_type LIKE '%M09192%' OR freeform LIKE '%M09192%') ORDER BY j.reported_at_iso DESC\").all() as any[]",
      "console.log('Found', cards.length, 'cards on M09192')",
      "for (const c of cards) {",
      "  const notes = db.query('SELECT kind, body FROM notes WHERE job_key = (SELECT key FROM jobs WHERE sorszam = ?)').all(c.sorszam) as any[]",
      "  const noteText = notes.map(n => n.body).join(' ')",
      "  const hasGolyos = /golyos/i.test(noteText)",
      "  const hasCsapagy = /csapagy/i.test(noteText)",
      "  const hasTengely = /tengely/i.test(noteText)",
      "  console.log('  ', c.sorszam, c.cust?.slice(0, 20), '| golyos:', hasGolyos, 'csapagy:', hasCsapagy, 'tengely:', hasTengely)",
      "  if (hasGolyos && hasCsapagy) {",
      "    console.log('     NOTE:', noteText.slice(0, 300))",
      "  }",
      "}",
      "db.close()",
      "TS",
      'echo "skipped (would need local db)";',
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
