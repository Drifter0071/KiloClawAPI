// _check-m09192i.ts - search /var/lib/cmms/cmms.db for M09192 in data table
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'cat > /tmp/q7.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "const db = new Database('/var/lib/cmms/cmms.db', { readonly: true })",
      "const cols = db.query('PRAGMA table_info(data)').all() as any[]",
      "for (const c of cols) {",
      "  const ty = (c.type || '').toUpperCase()",
      "  if (!ty.includes('TEXT') && !ty.includes('VARCHAR')) continue",
      "  const qcol = '\"' + c.name.replace(/\"/g,'\"\"') + '\"'",
      "  try {",
      "    const rows = db.query(`SELECT ${qcol} as v FROM data WHERE CAST(${qcol} AS TEXT) LIKE '%09192%' LIMIT 5`).all() as any[]",
      "    if (rows.length) {",
      "      console.log(`== ${c.name}: ${rows.length} ==`)",
      "      for (const r of rows) console.log('  ', JSON.stringify(r).slice(0, 800))",
      "    }",
      "  } catch (e) {}",
      "}",
      "db.close()",
      "TS",
      'bun run /tmp/q7.ts 2>&1',
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
