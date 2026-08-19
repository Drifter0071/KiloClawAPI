// _check-port.ts
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== port 8787 ==="',
      'ss -tlnp 2>/dev/null | grep 8787 || netstat -tlnp 2>/dev/null | grep 8787 || echo no ss/netstat',
      'echo "=== curl 8787 health ==="',
      'curl -s -m 5 http://127.0.0.1:8787/v1/health 2>&1 | head -c 500',
      'echo ""',
      'echo "=== curl with token, full output ==="',
      'TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)',
      'curl -v -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"device":"M09192","q":"X tengely golyós orsó csapágyak típusa és mennyisége munkánál","limit":3}\' 2>&1 | tail -30',
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
