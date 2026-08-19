// _test-bare-q.ts - test bare q=M09192 after the fix
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)',
      'echo "=== bare q=M09192 (no device, no other tokens) ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"M09192","limit":3}\' | head -c 800',
      'echo ""',
      'echo "=== q=M09192 with descriptive prose ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"X tengely golyós orsó csapágyak típusa és mennyisége M09192 munkánál","limit":3}\' | head -c 800',
      'echo ""',
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
