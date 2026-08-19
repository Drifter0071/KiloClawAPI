// _check-m09192-final.ts - look in cmms.db data table for X tengely golyos orso csapagy on M09192
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'cat > /tmp/q10.ts << "TS"',
      "import { Database } from 'bun:sqlite'",
      "const db = new Database('/var/lib/cmms/cmms.db')",
      "const cols = db.query('PRAGMA table_info(data)').all() as any[]",
      "// Look in any text column for golyos + orso + csapagy on M09192",
      "for (const c of cols) {",
      "  const ty = (c.type || '').toUpperCase()",
      "  if (!ty.includes('TEXT') && !ty.includes('VARCHAR')) continue",
      "  const qcol = '\"' + c.name.replace(/\"/g,'\"\"') + '\"'",
      "  try {",
      "    const sql = `SELECT ${qcol} as v FROM data WHERE CAST(${qcol} AS TEXT) LIKE '%09192%' AND (CAST(${qcol} AS TEXT) LIKE '%golyos%orso%' OR CAST(${qcol} AS TEXT) LIKE '%X tengely%csapagy%' OR CAST(${qcol} AS TEXT) LIKE '%golyosors%' OR CAST(${qcol} AS TEXT) LIKE '%30TAC%' OR CAST(${qcol} AS TEXT) LIKE '%csapagy%X%')`",
      "    const rows = db.query(sql).all() as any[]",
      "    if (rows.length) {",
      "      console.log(`== ${c.name}: ${rows.length} matches ==`)",
      "      for (const r of rows.slice(0, 3)) console.log('  ', JSON.stringify(r).slice(0, 800))",
      "    }",
      "  } catch (e) {}",
      "}",
      "// Also: find ANY row mentioning X tengely + golyos + orso anywhere in cmms.db",
      "console.log('\\n=== ANY row with X tengely + golyos + orso ===')",
      "for (const c of cols) {",
      "  const ty = (c.type || '').toUpperCase()",
      "  if (!ty.includes('TEXT') && !ty.includes('VARCHAR')) continue",
      "  const qcol = '\"' + c.name.replace(/\"/g,'\"\"') + '\"'",
      "  try {",
      "    const sql = `SELECT ${qcol} as v FROM data WHERE CAST(${qcol} AS TEXT) LIKE '%golyos orso%' OR CAST(${qcol} AS TEXT) LIKE '%golyós orsó%' OR CAST(${qcol} AS TEXT) LIKE '%X tengely csapagy%' OR CAST(${qcol} AS TEXT) LIKE '%X-tengely csapágy%' LIMIT 3`",
      "    const rows = db.query(sql).all() as any[]",
      "    if (rows.length) {",
      "      console.log(`  ${c.name}: ${rows.length} matches`)",
      "      for (const r of rows) console.log('    ', JSON.stringify(r).slice(0, 800))",
      "    }",
      "  } catch (e) {}",
      "}",
      "db.close()",
      "TS",
      'bun run /tmp/q10.ts 2>&1 | head -60',
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
