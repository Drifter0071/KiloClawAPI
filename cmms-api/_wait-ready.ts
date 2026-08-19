// _wait-ready.ts — poll the cmms-api service until /v1/feedback/counters
// returns 200 (i.e. ETL done and HTTP listener up), then dump the
// recent log lines and the model env.
import { Client } from 'ssh2'

const HOST = '10.0.3.81'
const USER = 'root'
const PASS = 'tarantula999'

const REMOTE_CMD = [
  // Loop up to 5 min (30 x 10s) until the port is listening.
  "for i in $(seq 1 30); do",
  "  if ss -tlnp 2>/dev/null | grep -q ':8787 '; then",
  "    echo \"--- port up after ${i} polls (~$((i * 10))s) ---\"; break",
  "  fi",
  "  sleep 10",
  "done",
  "echo '--- service status ---'",
  "systemctl is-active cmms-api",
  "echo '--- listening on 8787 ---'",
  "ss -tlnp 2>/dev/null | grep ':8787 ' || echo 'NOT LISTENING'",
  "echo '--- env (KILO_MODEL) ---'",
  "grep '^KILO_MODEL' /etc/cmms-api.env",
  "echo '--- recent log lines ---'",
  "journalctl -u cmms-api --since '2 min ago' --no-pager -o cat | tail -15",
  "echo '--- counters (auth sanity) ---'",
  "curl -s -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1:8787/v1/feedback/counters -H 'authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89'",
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
