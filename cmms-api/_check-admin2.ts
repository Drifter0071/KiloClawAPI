// _check-admin2.ts — pull the served /dashboard/admin/disliked HTML to see what chunks it references
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== /dashboard/admin HTML ==="',
      'curl -sS -H "skip_zrok_interstitial: 1" "https://nctmechanic.shares.zrok.io/dashboard/admin/disliked" 2>&1 | head -120',
      'echo "=== base-DVdU1azu asset search ==="',
      'ls /opt/cmms-api/dashboard/v2/assets/ | grep -i base | head -5',
      'echo "=== old hash present? ==="',
      'ls /opt/cmms-api/dashboard/v2/assets/ | grep hR7stxT',
    ].join(' ; '),
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
