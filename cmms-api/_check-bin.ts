// _check-bin.ts — see what cmms-api is actually running and what env it has
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    "ls -la /opt/cmms-api/ | head -40 && echo === && systemctl show cmms-api -p ExecStart && echo === && grep -E 'KILO_MODEL|LLM_' /etc/cmms-api.env /opt/cmms-api/*.env 2>/dev/null",
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
