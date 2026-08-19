// _check-status.ts — verify cmms-api is up and report the current
// service status.
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "systemctl is-active cmms-api cmms-mcp && echo --- && curl -s -o /dev/null -w 'cmms-api: %{http_code}\\n' http://127.0.0.1:8787/v1/feedback/counters -H 'authorization: Bearer $(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2 | tr -d \"\\\"\")' && echo --- && ls -la /opt/cmms-api/cmms-api-linux",
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
