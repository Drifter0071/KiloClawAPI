// Atomically swap in the new spec db and restart cmms-api.
import { Client } from "ssh2";
const c = new Client();
let out = "";
const steps = [
  // Stop cmms-api first (it's already stopped from the previous loop, but be safe)
  "systemctl stop cmms-api.service 2>&1 || true",
  // Remove WAL/SHM sidecars to make sure the new file is read fresh
  "rm -f /var/lib/cmms/cmms_specialized.db-shm /var/lib/cmms/cmms_specialized.db-wal",
  // Atomic swap
  "mv /var/lib/cmms/cmms_specialized.db.new /var/lib/cmms/cmms_specialized.db",
  "chown cmmsapi:cmmsapi /var/lib/cmms/cmms_specialized.db",
  "chmod 0644 /var/lib/cmms/cmms_specialized.db",
  // Start
  "systemctl start cmms-api.service",
];
c.on("ready", () => {
  let i = 0;
  function runNext() {
    if (i >= steps.length) {
      c.end();
      return;
    }
    const cmd = steps[i++];
    console.log(`> ${cmd}`);
    c.exec(cmd, (err, s) => {
      s.on("data", (d: Buffer) => { process.stdout.write(d.toString()); });
      s.on("close", (code: number) => {
        console.log(`  exit: ${code}`);
        setTimeout(runNext, 200);
      });
    });
  }
  runNext();
});
c.on("error", (e: Error) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
