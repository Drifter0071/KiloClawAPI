const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== user-level systemd units for root ==='",
    "systemctl --user list-units --all 2>/dev/null | grep -iE 'zrok' || echo '(no user units match zrok)'",
    "echo '=== system unit files mentioning zrok ==='",
    "ls -la /etc/systemd/system/ | grep -i zrok; ls -la /usr/lib/systemd/user/ 2>/dev/null | grep -i zrok || true",
    "echo '=== zrok.service unit file mtime ==='",
    "stat -c '%y %n' /etc/systemd/system/zrok.service 2>/dev/null",
    "echo '=== run-zrok.sh mtime ==='",
    "stat -c '%y %n' /usr/local/bin/run-zrok.sh 2>/dev/null",
    "echo '=== who started manual agent? check user session ==='",
    "loginctl list-sessions 2>/dev/null | head -5; ps -o pid,ppid,etime,cmd -p 1913750 2>/dev/null",
    "echo '=== zrok.service today: first + last conflict times ==='",
    "journalctl -u zrok --since '2026-08-19 00:00' --no-pager | grep shareConflict | head -2",
    "journalctl -u zrok --since '2026-08-19 00:00' --no-pager | grep shareConflict | tail -2",
  ].join("\n");
  c.exec(cmd, (err, stream) => {
    if (err) { console.error(err); c.end(); return; }
    let out = "";
    stream.on("data", (d) => out += d.toString());
    stream.on("close", () => { console.log(out); c.end(); });
  });
}).on("error", (e) => console.error("err", e.message)).connect({
  host: "10.0.3.81", port: 22, username: "root", password: "tarantula999",
});
