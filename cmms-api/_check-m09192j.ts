// _check-m09192j.ts - open the specialized DB with WAL mode and look for M09192
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'cat > /tmp/q8.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "const db = new Database('/var/lib/cmms/cmms_specialized.db')",
      "db.exec('PRAGMA journal_mode = WAL')",
      "console.log('WAL mode:', db.query('PRAGMA journal_mode').get())",
      "console.log('row count jobs:', db.query('SELECT COUNT(*) as c FROM jobs').get())",
      "// Now search M09192",
      "for (const table of ['jobs', 'devices', 'notes', 'customers']) {",
      "  const cols = db.query(`PRAGMA table_info(${table})`).all() as any[]",
      "  if (!cols.length) continue",
      "  const colNames = cols.map(c => c.name)",
      "  if (colNames.includes('sorszam')) {",
      "    const rows = db.query(`SELECT sorszam FROM ${table} WHERE sorszam LIKE '%09192%' LIMIT 5`).all() as any[]",
      "    if (rows.length) console.log(`${table}.sorszam matches:`, rows)",
      "  }",
      "  for (const c of cols) {",
      "    const ty = (c.type || '').toUpperCase()",
      "    if (!ty.includes('TEXT') && !ty.includes('VARCHAR')) continue",
      "    try {",
      "      const rows = db.query(`SELECT * FROM ${table} WHERE CAST(${c.name} AS TEXT) LIKE '%09192%' LIMIT 5`).all() as any[]",
      "      if (rows.length) {",
      "        console.log(`${table}.${c.name} (${rows.length}):`)",
      "        for (const r of rows) console.log('  ', JSON.stringify(r).slice(0, 400))",
      "      }",
      "    } catch {}",
      "  }",
      "}",
      "db.close()",
      "TS",
      'bun run /tmp/q8.ts 2>&1 | head -80',
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
