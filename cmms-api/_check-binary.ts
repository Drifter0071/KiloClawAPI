// _check-binary.ts — check deployed binary size + ETL completion.
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    "ls -la /opt/cmms-api/cmms-api /opt/cmms-api/cmms-api.new 2>&1; echo '---'; curl -s -o /dev/null -w 'counters: %{http_code}\\n' http://127.0.0.1:8787/v1/feedback/counters -H \"authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89\"; echo '---'; journalctl -u cmms-api --since '60 seconds ago' --no-pager -o cat | tail -8",
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
