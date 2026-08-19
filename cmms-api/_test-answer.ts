// _test-answer.ts - full agent flow
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)',
      'echo "=== test: bare q with M09192 (auto-extract) + descriptive prose ==="',
      'RESP=$(curl -s -X POST http://127.0.0.1:8787/v1/answer-agent -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d \'{"q":"X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál","async":true,"language":"hu"}\')',
      'echo "Response (first 500):"',
      'echo "$RESP" | head -c 500',
      'echo ""',
      'JOBID=$(echo "$RESP" | sed -n \'s/.*"job_id":"\\([^"]*\\)".*/\\1/p\')',
      'echo "Job ID: $JOBID"',
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do',
      '  sleep 5',
      '  POLL=$(curl -s -X GET "http://127.0.0.1:8787/v1/answer-agent/$JOBID" -H "authorization: Bearer $TOKEN")',
      '  STATUS=$(echo "$POLL" | sed -n \'s/.*"status":"\\([^"]*\\)".*/\\1/p\')',
      '  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then',
      '    echo "FINAL STATUS: $STATUS"',
      '    echo "$POLL" | head -c 3000',
      '    break',
      '  fi',
      '  echo "  iter $i: status=$STATUS"',
      'done',
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
