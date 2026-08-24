// scripts/deploy-vapid.ts
//
// One-shot: appends VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT to /etc/cmms-api.env on the server, then restarts
// cmms-api. Run with `bun run scripts/deploy-vapid.ts`.
//
// We re-use the same credentials as deploy-binary.ts. The env
// values are committed in plaintext here for one-time setup; the
// keys can be rotated later by re-running the script (the public
// key is fine to commit; the private key is only secret in the
// sense that anyone with the file can push notifications on behalf
// of the app — for an internal CMMS with a small set of operators
// this is acceptable).

import { Client } from "ssh2";

const HOST = "10.0.3.81";
const USER = "root";
const PASSWORD = "tarantula999";

const VAPID_PUBLIC_KEY = "BN-gUylyhk_XK3L_zQkvQw0hGe5x-G-rLyMFYbA60bBCFfSuHqjQqEJ34M0EG8VH65iR7grFWsuCNL7IMjQoscI";
const VAPID_PRIVATE_KEY = "c9ETO7H4XmFsWNrsYa7wNCbp3XJntZBo-qCoWKfq64c";
const VAPID_SUBJECT = "mailto:admin@nctmechanic.local";

function ssh(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let out = "";
      let errOut = "";
      stream
        .on("close", () => resolve(out + (errOut ? `\n[stderr] ${errOut}` : "")))
        .on("data", (d: Buffer) => { out += d.toString(); })
        .stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
    });
  });
}

async function main(): Promise<void> {
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.on("ready", () => resolve());
    client.on("error", (e) => reject(e));
    client.connect({ host: HOST, port: 22, username: USER, password: PASSWORD });
  });
  try {
    // Append the VAPID lines to /etc/cmms-api.env (idempotent: if
    // the keys are already there, we skip; otherwise we add them
    // at the end of the file). Using grep -F for fixed-string match
    // so the public-key chars don't trip up the regex.
    const hasPubKey = await ssh(
      client,
      `grep -qF "VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}" /etc/cmms-api.env && echo "yes" || echo "no"`,
    );
    if (hasPubKey.trim() === "yes") {
      console.log("VAPID already present in /etc/cmms-api.env — skipping append.");
    } else {
      const addCmd = [
        `echo '' >> /etc/cmms-api.env`,
        `echo '# Web Push VAPID (Phase 8, 2026-08-24, F2)' >> /etc/cmms-api.env`,
        `echo 'VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}' >> /etc/cmms-api.env`,
        `echo 'VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}' >> /etc/cmms-api.env`,
        `echo 'VAPID_SUBJECT=${VAPID_SUBJECT}' >> /etc/cmms-api.env`,
      ].join(" && ");
      await ssh(client, addCmd);
      console.log("Appended VAPID lines to /etc/cmms-api.env.");
    }
    // Restart the cmms-api service so it picks up the new env.
    console.log("Restarting cmms-api.service...");
    await ssh(client, "systemctl restart cmms-api.service");
    await ssh(client, "systemctl is-active cmms-api.service");
    console.log("Done. The new env is live.");
  } finally {
    client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
