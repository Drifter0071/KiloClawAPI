// _check-admin.ts — list what's on the server for the admin SPA
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== admin/assets/ ==="',
      'ls -la /opt/cmms-api/dashboard/admin/assets/ 2>&1 | head -40',
      'echo "=== v2/assets Disliked ==="',
      'ls /opt/cmms-api/dashboard/v2/assets/ 2>&1 | grep -i disliked',
      'echo "=== admin/assets hR7stxT ==="',
      'ls /opt/cmms-api/dashboard/admin/assets/ 2>&1 | grep hR7stxT',
    ].join(' ; '),
    (e, stream) => {
      if (e) {
        console.error('exec error', e)
        c.end()
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => {
        console.log(out)
        c.end()
      })
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
