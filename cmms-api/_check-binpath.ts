// _check-binpath.ts — find where the running cmms-api binary lives.
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "echo '=== service ExecStart ==='; systemctl cat cmms-api | grep -E 'ExecStart|WorkingDirectory' | head -5; echo '=== all cmms-api-linux on disk ==='; find / -name 'cmms-api-linux' -type f 2>/dev/null; echo '=== running process ==='; ps -ef | grep -E 'cmms-api|cmms-api-linux' | grep -v grep",
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
