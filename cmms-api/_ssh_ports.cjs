const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== listening ports (public) ==='",
    "ss -tlnp | grep -E ':80 |:443 |:8787|:8788' || ss -tlnp | head -20",
    "echo '=== reverse proxies ==='",
    "ps -ef | grep -iE 'nginx|caddy|traefik|haproxy' | grep -v grep || echo '(none running)'",
    "echo '=== zrok environment/config search ==='",
    "ls -la ~/.zrok/ 2>/dev/null; find / -name 'zrok.yml' -not -path '*/proc/*' 2>/dev/null | head -5",
    "echo '=== nginx sites ==='",
    "ls /etc/nginx/sites-enabled/ 2>/dev/null && grep -rE 'proxy_read_timeout|proxy_pass' /etc/nginx/sites-enabled/ 2>/dev/null | head -10 || echo '(no nginx)'",
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
