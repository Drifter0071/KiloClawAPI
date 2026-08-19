// _check-m09192d.ts — look at csv-integration dir, check the actual jobs table fully
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    `echo === CSV INTEGRATION DIR === ; ls -la /opt/cmms-api/csv-integration/ 2>&1 | head -40
echo === ALL DIRS UNDER /opt/cmms-api/ === ; find /opt/cmms-api -maxdepth 3 -type d 2>/dev/null | head -30
echo === ALL DB FILES ON DISK === ; find / -name '*.db' -size +0 2>/dev/null | head -20
echo === jobs table full content (rows with 09192 anywhere) === ; cat > /tmp/q4.ts <<'TS'
import { Database } from 'bun:sqlite'
const db = new Database('/var/lib/cmms/cmms_specialized.db', { readonly: true })
// jobs.sorszam is the only place 09192 could live. List all of them
const all = db.query('SELECT COUNT(*) as c FROM jobs').get() as any
console.log('jobs total rows:', all.c)
// Look at customer_id - is there a customers table?
const tabs = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]
console.log('all tables:', tabs.map(t => t.name).join(','))
db.close()
TS
bun run /tmp/q4.ts 2>&1`,
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
