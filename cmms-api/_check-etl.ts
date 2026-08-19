// _check-etl.ts - did the ETL fail?
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== etl log lines (last 80) ==="',
      'journalctl -u cmms-api --since "15:00" --no-pager 2>/dev/null | grep -iE "etl|error|panic|fatal" | tail -40',
      'echo "=== /opt/cmms-api/.env contents ==="',
      'cat /opt/cmms-api/.env',
      'echo "=== ls -la /var/lib/cmms ==="',
      'ls -la /var/lib/cmms/',
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
