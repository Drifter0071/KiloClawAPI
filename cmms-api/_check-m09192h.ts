// _check-m09192h.ts - search the REAL db files
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== ls -la both dbs ==="',
      'ls -la /var/lib/cmms/*.db /root/*.db',
      'echo "=== /root/cmms_specialized.db - tables and counts ==="',
      'cat > /tmp/q5.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "for (const path of ['/root/cmms_specialized.db','/var/lib/cmms/cmms.db']) {",
      "  console.log('========', path, '========')",
      "  try {",
      "    const db = new Database(path, { readonly: true })",
      "    const tabs = db.query(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all() as any[]",
      "    for (const t of tabs) {",
      "      const n = db.query(`SELECT COUNT(*) as c FROM ${t.name}`).get() as any",
      "      console.log(`  ${t.name}: ${n.c} rows`)",
      "    }",
      "    db.close()",
      "  } catch (e) { console.log('  err:', (e as Error).message) }",
      "}",
      "TS",
      'bun run /tmp/q5.ts 2>&1',
      'echo "=== Search for M09192 in /root/cmms_specialized.db ==="',
      'cat > /tmp/q6.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "const db = new Database('/root/cmms_specialized.db', { readonly: true })",
      "const tabs = db.query(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all() as any[]",
      "for (const t of tabs) {",
      "  const cols = db.query(`PRAGMA table_info(${t.name})`).all() as any[]",
      "  const colNames = cols.map(c => c.name.toLowerCase())",
      "  const hits: any[] = []",
      "  // Check sorszam",
      "  if (colNames.includes('sorszam')) {",
      "    const rows = db.query(`SELECT * FROM ${t.name} WHERE sorszam LIKE '%09192%' LIMIT 10`).all() as any[]",
      "    for (const r of rows) hits.push({via: 'sorszam', row: r})",
      "  }",
      "  // Check every text col",
      "  for (const c of cols) {",
      "    const ty = (c.type || '').toUpperCase()",
      "    if (!ty.includes('TEXT') && !ty.includes('VARCHAR')) continue",
      "    try {",
      "      const rows = db.query(`SELECT * FROM ${t.name} WHERE CAST(${c.name} AS TEXT) LIKE '%09192%' LIMIT 5`).all() as any[]",
      "      for (const r of rows) hits.push({via: c.name, row: r})",
      "    } catch {}",
      "  }",
      "  if (hits.length) {",
      "    console.log(`  ${t.name}: ${hits.length} hits`);",
      "    for (const h of hits.slice(0,5)) console.log('   ', h.via, JSON.stringify(h.row).slice(0,400))",
      "  }",
      "}",
      "db.close()",
      "TS",
      'bun run /tmp/q6.ts 2>&1',
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
