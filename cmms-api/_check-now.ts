// _check-now.ts
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== current process ==="',
      'ps -ef | grep cmms-api | grep -v grep',
      'echo "=== latest 5 log lines ==="',
      'journalctl -u cmms-api -n 5 --no-pager 2>/dev/null',
      'echo "=== test 1 ==="',
      'TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"device":"M09192","q":"X tengely golyós orsó csapágyak típusa és mennyisége munkánál","limit":3}\' | head -c 1500',
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
