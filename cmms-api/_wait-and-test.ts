// _wait-and-test.ts - wait for ETL + test the new soft-q behavior
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'echo "=== latest etl_done ==="',
      'journalctl -u cmms-api -n 1000 --no-pager 2>/dev/null | grep etl_done | tail -3',
      'TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)',
      'echo ""',
      'echo "=== test 1: device=M09192 + q with descriptive prose (user exact question) ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"device":"M09192","q":"X tengely golyós orsó csapágyak típusa és mennyisége munkánál","limit":3}\'',
      'echo ""',
      'echo "=== test 2: auto-extract M09192 from q ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/jobs/search -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"X tengely golyós orsó csapágyak típusa és mennyisége M09192 munkánál","limit":3}\'',
      'echo ""',
      'echo "=== test 3: answer_question flow ==="',
      'curl -s -X POST http://127.0.0.1:8787/v1/answer-agent -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál","async":true}\' | head -c 500',
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
