// _test-m09192-search.ts - test the actual /v1/jobs/search endpoint with M09192
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)',
      'echo "=== test 1: q=M09192 ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"M09192","limit":5}\' | head -c 2000',
      'echo ""',
      'echo "=== test 2: device=M09192 ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"device":"M09192","limit":5}\' | head -c 2000',
      'echo ""',
      'echo "=== test 3: q=csapagy M09192 ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"csapagy M09192","limit":5}\' | head -c 2000',
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
