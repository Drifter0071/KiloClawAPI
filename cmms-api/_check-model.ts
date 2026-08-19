// _check-model.ts — verify the deployed cmms-api has the new model
// default. We hit /v1/feedback/counters (a tiny read-gated endpoint)
// and check the log output is fresh. Simpler: just tail the journal
// for "llm" calls and check the model.
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "journalctl -u cmms-api --since '5 min ago' --no-pager -o cat | grep -E 'model|luna|gpt-5' | tail -10",
    (e, stream) => {
      if (e) { console.error('exec error', e); c.end(); return }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => { console.log(out); c.end() })
    },
  )
})
c.on('error', (e) => console.error('conn error', e))
c.connect({
  host: '10.0.3.81',
  port: 22,
  username: 'root',
  password: 'tarantula999',
})
