// _check-deploy.ts — verify the deployed dashboard-v2 dist has the new code
import { Client } from 'ssh2'

const c = new Client()
c.on('ready', () => {
  c.exec(
    'ls -la /opt/cmms-api/dashboard/v2/assets/AskPage-*.js && echo --- && grep -c send-correct-answer-sent /opt/cmms-api/dashboard/v2/assets/AskPage-*.js && echo --- && grep -c loadMyCorrections /opt/cmms-api/dashboard/v2/assets/AskPage-*.js',
    (e, stream) => {
      if (e) {
        console.error('exec error', e)
        c.end()
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += '[stderr] ' + d.toString()))
      stream.on('close', () => {
        console.log(out)
        c.end()
      })
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
