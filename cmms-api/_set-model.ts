// _set-model.ts — flip the KILO_MODEL env on the server, restart
// cmms-api, and verify the new value is in effect.
import { Client } from 'ssh2'

const HOST = '10.0.3.81'
const USER = 'root'
const PASS = 'tarantula999'

// 1) sed-replace the KILO_MODEL line in /etc/cmms-api.env.
// 2) Restart the service so the new env is picked up.
const REMOTE_CMD = [
  // Backup the env first, in case we need to revert.
  "cp -f /etc/cmms-api.env /etc/cmms-api.env.bak.$(date +%s)",
  // Replace KILO_MODEL=... with the new value (idempotent).
  "sed -i -E 's|^KILO_MODEL=.*$|KILO_MODEL=openai/gpt-5.6-luna-pro|' /etc/cmms-api.env",
  "echo '--- updated env ---'",
  "grep '^KILO_MODEL' /etc/cmms-api.env",
  "echo '--- restarting cmms-api ---'",
  "systemctl restart cmms-api",
  "sleep 2",
  "echo '--- service status ---'",
  "systemctl is-active cmms-api",
  "echo '--- listening on 8787 ---'",
  "ss -tlnp 2>/dev/null | grep ':8787 ' || echo 'NOT LISTENING YET'",
  "echo '--- fresh log lines ---'",
  "journalctl -u cmms-api --since '8 seconds ago' --no-pager -o cat | tail -20",
].join(' && ')

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
