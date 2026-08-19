// _check-db.ts — query the production cmms_specialized.db for any
// feedback_corrections / votes rows.
import { Database } from 'bun:sqlite'
import { Client } from 'ssh2'
import { readFileSync } from 'node:fs'

// Pull the db file via ssh then query it locally.
const HOST = '10.0.3.81'
const USER = 'root'
const PASS = 'tarantula999'
const REMOTE = '/var/lib/cmms/cmms_specialized.db'
const LOCAL = 'C:/Users/garvanger/Documents/GitHub/KiloClawAPI/cmms-api/_cmms_spec.db'

const c = new Client()
c.on('ready', () => {
  c.sftp((err, sftp) => {
    if (err) { console.error('sftp err', err); c.end(); return }
    sftp.fastGet(REMOTE, LOCAL, (e) => {
      if (e) { console.error('fastGet err', e); c.end(); return }
      run()
      c.end()
    })
  })
})
c.on('error', (e) => { console.error('conn err', e) })
c.connect({ host: HOST, port: 22, username: USER, password: PASS })

function run(): void {
  const d = new Database(LOCAL, { readonly: true })
  const v = d.query("SELECT COUNT(*) AS n FROM feedback_votes").get() as { n: number }
  const c2 = d.query("SELECT COUNT(*) AS n FROM feedback_corrections").get() as { n: number }
  const a = d.query("SELECT COUNT(*) AS n FROM feedback_answers").get() as { n: number }
  console.log('votes:', v.n, 'corrections:', c2.n, 'answers:', a.n)
  if (v.n > 0) {
    console.log('votes sample:', d.query("SELECT uid, answer_id, vote, reason, created_at FROM feedback_votes ORDER BY created_at DESC LIMIT 5").all())
  }
  if (c2.n > 0) {
    console.log('corrections sample:', d.query("SELECT uid, answer_id, correction, created_at FROM feedback_corrections ORDER BY created_at DESC LIMIT 5").all())
  }
  d.close()
}
