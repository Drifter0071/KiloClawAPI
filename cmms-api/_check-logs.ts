// _check-logs.ts
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== last 30 log lines ==="',
      'journalctl -u cmms-api -n 30 --no-pager 2>/dev/null',
      'echo "=== process status ==="',
      'systemctl status cmms-api --no-pager 2>&1 | head -20',
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
