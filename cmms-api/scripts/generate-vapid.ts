// scripts/generate-vapid.ts
//
// One-shot helper: generates a VAPID keypair and prints the env
// lines to add to /etc/cmms-api.env. Run with `bun run
// scripts/generate-vapid.ts`. The output is just the env lines; we
// don't write to disk here — the operator pastes them into the
// server config and restarts the service.
//
// Why a script and not an env auto-generation at boot?
//   - VAPID keys MUST be stable across server restarts. Auto-
//     generating at boot would invalidate every device's
//     subscription every time the process restarts.
//   - The dashboard subscribes once with this key; rotating the
//     key forces every user to re-subscribe.

import webpush from "web-push"

const keys = webpush.generateVAPIDKeys()
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey)
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey)
console.log("VAPID_SUBJECT=mailto:admin@nctmechanic.local")
