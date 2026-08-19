// _check-disliked.ts — hit the /v1/feedback/disliked endpoint
// directly to verify the new correction fields are present.
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "curl -s 'http://127.0.0.1:8787/v1/feedback/disliked?limit=3' -H 'authorization: Bearer 8b459aa11abbe90062824be3a7f7b0580e10906c80d2956c03f6c8766fd4eccd' | head -c 2000",
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
