// _check-m09192c.ts — exhaustive search for M09192 across all DBs the agent can see
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    `cat > /tmp/q3.ts <<'TS'
import { Database } from 'bun:sqlite'
import { readdirSync, statSync } from 'fs'

const roots = ['/var/lib/cmms']
for (const root of roots) {
  let files: string[] = []
  try { files = readdirSync(root).filter(f => f.endsWith('.db')) } catch (e) { continue }
  for (const f of files) {
    const path = root + '/' + f
    console.log('========', path, '========')
    const db = new Database(path, { readonly: true })
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\\\' ORDER BY name").all() as any[]
    for (const t of tables) {
      const cols = db.query(\`PRAGMA table_info(\${t.name})\`).all() as any[]
      const colNames = cols.map(c => c.name)
      const sorszamLike = colNames.some(n => n.toLowerCase() === 'sorszam')
      // Search for M09192 in sorszam OR in any text column
      let count = 0
      let sample: any[] = []
      if (sorszamLike) {
        const rows = db.query(\`SELECT * FROM \${t.name} WHERE sorszam LIKE '%09192%' LIMIT 5\`).all() as any[]
        count += rows.length
        sample.push(...rows)
      }
      // Also any text column that contains 09192
      for (const c2 of cols) {
        const ty = (c2.type || '').toUpperCase()
        if (!ty.includes('TEXT') && !ty.includes('VARCHAR') && !ty.includes('CHAR')) continue
        try {
          const rows = db.query(\`SELECT * FROM \${t.name} WHERE CAST(\${c2.name} AS TEXT) LIKE '%09192%' LIMIT 5\`).all() as any[]
          if (rows.length) {
            count += rows.length
            sample.push({ _col: c2.name, rows })
          }
        } catch {}
      }
      if (count > 0) {
        console.log('  table', t.name, '->', count, 'hits')
        for (const s of sample.slice(0, 3)) {
          if (s._col) {
            console.log('    [in col', s._col + ']')
            for (const r of s.rows) console.log('     ', JSON.stringify(r).slice(0, 300))
          } else {
            console.log('     ', JSON.stringify(s).slice(0, 300))
          }
        }
      }
    }
    db.close()
  }
}
TS
bun run /tmp/q3.ts 2>&1 | head -120`,
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
