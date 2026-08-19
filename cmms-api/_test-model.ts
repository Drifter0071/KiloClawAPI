// _test-model.ts — fire one answer-agent call to the new binary and
// grep the model name out of the response.
import { Client } from 'ssh2'

const HOST = '10.0.3.81'
const USER = 'root'
const PASS = 'tarantula999'

const REMOTE_CMD = [
  // Start a job.
  "echo '--- starting agent job ---'",
  "JOB=$(curl -s -X POST 'http://127.0.0.1:8787/v1/answer-agent' \\",
  "  -H 'authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89' \\",
  "  -H 'content-type: application/json' \\",
  "  -d '{\"q\":\"Melyik ügyfélhez tartozik az M26057?\",\"language\":\"hu\"}' )",
  "echo \"$JOB\" | head -c 200; echo",
  "JOB_ID=$(echo \"$JOB\" | grep -o '\"job_id\":\"[^\"]*' | head -1 | cut -d'\"' -f4)",
  "echo \"--- job_id=$JOB_ID ---\"",
  // Poll up to 60s.
  "for i in $(seq 1 30); do",
  "  sleep 2",
  "  STATE=$(curl -s \"http://127.0.0.1:8787/v1/answer-agent/${JOB_ID}\" -H 'authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89')",
  "  STATUS=$(echo \"$STATE\" | grep -o '\"status\":\"[^\"]*' | head -1 | cut -d'\"' -f4)",
  "  echo \"poll $i: status=$STATUS\"",
  "  if [ \"$STATUS\" = \"done\" ] || [ \"$STATUS\" = \"error\" ]; then",
  "    echo \"--- final response ---\"",
  "    echo \"$STATE\" | head -c 4000",
  "    echo",
  "    break",
  "  fi",
  "done",
  "echo '--- model in response (grep) ---'",
  // Also dump the synchronous path's response if that's what came back.
  "RESP=$(curl -s -X POST 'http://127.0.0.1:8787/v1/answer-agent' -H 'authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89' -H 'content-type: application/json' -d '{\"q\":\"Melyik ügyfélhez tartozik az M26057?\",\"language\":\"hu\"}')",
  "echo \"$RESP\" | grep -oE '\"model\":\"[^\"]*\"' | head -3",
].join('\n')

const c = new Client()
c.on('ready', () => {
  c.exec(REMOTE_CMD, (e, stream) => {
    if (e) { console.error('exec error', e); c.end(); return }
    let out = ''
    stream.on('data', (d: Buffer) => (out += d.toString()))
    stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
    stream.on('close', () => { console.log(out); c.end() })
  })
})
c.on('error', (e) => console.error('conn error', e))
c.connect({ host: HOST, port: 22, username: USER, password: PASS })
