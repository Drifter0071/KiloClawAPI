// _check-env.ts — check the cmms-api env file and the running binary.
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "echo '=== /etc/cmms-api.env ==='; cat /etc/cmms-api.env; echo '=== running binary ==='; ls -la /opt/cmms-api/cmms-api-linux; echo '=== service active ==='; systemctl is-active cmms-api; echo '=== port 8787 ==='; ss -tlnp 2>/dev/null | grep -E ':(8787|8788) ' || echo 'neither port listening'; echo '=== agent logs (last 30s) ==='; journalctl -u cmms-api --since '90 seconds ago' --no-pager -o cat | tail -40",
    (e, stream) => {
      if (e) { console.error('exec error', e); c.end(); return }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => { console.log(out); c.end() })
    },
  )
})
c.on('error', (e) => console.error('conn error', e))
c.connect({
  host: '10.0.3.81',
  port: 22,
  username: 'root',
  password: 'tarantula999',
})
