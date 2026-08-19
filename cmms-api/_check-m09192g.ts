// _check-m09192g.ts
import { Client } from 'ssh2'
const c = new Client()
c.on('ready', () => {
  c.exec(
    [
      'cat /etc/cmms-api.env',
      'echo === MCMPSENV ===',
      'cat /opt/cmms-api/mcp-cmms.env',
      'echo === PROCESS INFO ===',
      'PID=$(systemctl show cmms-api -p MainPID | cut -d= -f2); echo MainPID=$PID',
      'ls -la /proc/$PID/cwd 2>/dev/null',
      'cat /proc/$PID/cmdline 2>/dev/null | tr "\\0" " "; echo',
      'cat /proc/$PID/environ 2>/dev/null | tr "\\0" "\\n" | grep -iE "db|cmms|sqlite|path" | head -30',
      'echo === DB FILES BIGGER THAN 1MB ===',
      'find / -name "*.db" -size +1M 2>/dev/null | head -20',
    ].join('; '),
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
