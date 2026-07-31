// Manually re-upload the spec db and verify the sha256 matches.
import { Client } from "ssh2";
import { createReadStream } from "node:fs";
import { statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const LOCAL = resolve("C:/Users/garvangel/Documents/KiloClawAPI/cmms-api/cmms_specialized.db");
const REMOTE = "/var/lib/cmms/cmms_specialized.db";
const TMP_REMOTE = "/var/lib/cmms/cmms_specialized.db.new";

const stat = statSync(LOCAL);
console.log(`local size: ${stat.size} bytes`);

// Compute local sha256
const hash = createHash("sha256");
const stream = createReadStream(LOCAL);
stream.on("data", (c) => hash.update(c));
await new Promise((res) => stream.on("end", res));
const localSha = hash.digest("hex");
console.log(`local sha256: ${localSha}`);

const c = new Client();
c.on("ready", () => {
  c.sftp((err, sftp) => {
    if (err) { c.end(); console.error(err); return; }
    // Remove old tmp if present
    sftp.unlink(TMP_REMOTE, () => {
      const ws = sftp.createWriteStream(TMP_REMOTE, { mode: 0o644, flags: "w" });
      const r = createReadStream(LOCAL);
      let written = 0;
      r.on("data", (chunk) => {
        written += chunk.length;
        if (written % (10 * 1024 * 1024) < chunk.length) {
          process.stdout.write(`\r  uploaded ${(written/1024/1024).toFixed(1)}/${(stat.size/1024/1024).toFixed(1)} MB`);
        }
      });
      r.pipe(ws);
      ws.on("close", () => {
        console.log(`\n  upload done: ${written} bytes`);
        // Verify on remote
        c.exec(`sha256sum ${TMP_REMOTE} && stat -c '%s' ${TMP_REMOTE}`, (err, s) => {
          s.on("data", (d: Buffer) => process.stdout.write(d.toString()));
          s.on("close", () => {
            c.end();
            console.log("done");
          });
        });
      });
      ws.on("error", (e) => { console.error("ws error:", e); c.end(); });
    });
  });
});
c.on("error", (e) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
