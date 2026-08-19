// _check-m09192b.ts — is M09192 a machine identifier (gep/mechanical_id)?
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    "cat > /tmp/q2.ts <<'TS'\nimport { Database } from 'bun:sqlite'\nconst db = new Database('/var/lib/cmms/cmms_specialized.db', { readonly: true })\nconst cols = db.query('PRAGMA table_info(jobs)').all().map((r:any)=>r.name)\nconsole.log('jobs columns:', cols.join(','))\nfor (const col of ['gep','machine','gep_id','customer','device','customer_name']) {\n  if (!cols.includes(col)) continue\n  const rows = db.query(`SELECT sorszam, ${col}, substr(notes,1,150) as n FROM jobs WHERE ${col} LIKE '%09192%' OR notes LIKE '%09192%' LIMIT 20`).all() as any[]\n  console.log('==', col, '==', rows.length)\n  for (const r of rows) console.log('  ', JSON.stringify(r))\n}\n// Also any device/gep that has 09192 in the name\nfor (const col of cols) {\n  const rows = db.query(`SELECT sorszam, ${col} FROM jobs WHERE CAST(${col} AS TEXT) LIKE '%09192%' LIMIT 5`).all() as any[]\n  if (rows.length) console.log(col, '->', rows)\n}\ndb.close()\nTS\nbun run /tmp/q2.ts 2>&1 | head -60",
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
