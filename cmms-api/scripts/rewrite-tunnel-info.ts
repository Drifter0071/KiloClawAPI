// Upload scripts/tunnel-info.sh to the server and run it.
import { Client } from "ssh2";
import { readFileSync } from "node:fs";

const c = new Client();
c.on("ready", async () => {
  function upload(local: string, remote: string) {
    return new Promise<void>((resolve, reject) => {
      c.sftp((err, sftp) => {
        if (err) { reject(err); return; }
        const ws = sftp.createWriteStream(remote, { mode: 0o755 });
        ws.on("close", () => resolve());
        ws.on("error", (e: Error) => reject(e));
        const raw = readFileSync(local);
        const cleaned = Buffer.from(raw.toString("utf-8").replace(/\r\n/g, "\n"), "utf-8");
        ws.end(cleaned);
      });
    });
  }
  function exec(cmd: string, timeout = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      c.exec(cmd, (err, stream) => {
        if (err) { resolve({ code: 1, stdout: "", stderr: String(err) }); return; }
        let stdout = "", stderr = "";
        const t = setTimeout(() => { resolve({ code: -1, stdout, stderr: stderr + "\nTIMEOUT" }); }, timeout);
        stream.on("data", d => { stdout += d.toString(); });
        stream.stderr.on("data", d => { stderr += d.toString(); });
        stream.on("close", code => { clearTimeout(t); resolve({ code, stdout, stderr }); });
      });
    });
  }
  await upload("scripts/tunnel-info.sh", "/tmp/tunnel-info.sh");
  const r = await exec("bash /tmp/tunnel-info.sh && echo --- && head -8 ~/tunnel-info.txt");
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  c.end();
});
c.on("error", e => console.log("conn err", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
