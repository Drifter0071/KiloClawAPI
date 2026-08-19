// _check-m09192.ts — does the M09192 sorszam actually exist in the DB?
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    "cd /opt/cmms-api && cat > /tmp/q.ts <<'TS'\nimport { Database } from 'bun:sqlite'\nfor (const path of ['/var/lib/cmms/cmms.db','/var/lib/cmms/cmms_specialized.db']) {\n  console.log('===', path, '===')\n  try {\n    const db = new Database(path, { readonly: true })\n    for (const t of ['data','jobs']) {\n      const cols = db.query(`PRAGMA table_info(${t})`).all().map((r:any)=>r.name)\n      if (!cols.length) { console.log(t,': (no table)'); continue }\n      if (!cols.includes('sorszam')) { console.log(t,': no sorszam col'); continue }\n      const noteCol = cols.includes('megjegyzes') ? 'megjegyzes' : cols.includes('notes') ? 'notes' : null\n      const sql = noteCol\n        ? `SELECT sorszam, substr(${noteCol},1,120) as n FROM ${t} WHERE sorszam LIKE '%09192%' LIMIT 20`\n        : `SELECT sorszam FROM ${t} WHERE sorszam LIKE '%09192%' LIMIT 20`\n      const rows = db.query(sql).all()\n      console.log(t+':', rows.length, 'rows')\n      for (const r of rows) console.log('  ', JSON.stringify(r))\n    }\n    db.close()\n  } catch (e) { console.log('  err:', (e as Error).message) }\n}\nTS\nbun run /tmp/q.ts 2>&1 | head -60",
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
