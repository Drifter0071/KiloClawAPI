// Direct probe on the server: POST /v1/answer-agent to 127.0.0.1:8787 (no zrok edge).
// Runs via ssh2. Prints status, wall time, body head.
const { Client } = require("ssh2");
const conn = new Client();
const TOKEN = "b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89";
const Q = "Kérem az M17191 gép előéletét napjainktól 2024.05.10-ig visszamenőleg";

const curl = [
  "curl -s -w '\\n__STATUS__%{http_code}__TIME__%{time_total}'",
  "-X POST http://127.0.0.1:8787/v1/answer-agent",
  "-H 'Authorization: Bearer " + TOKEN + "'",
  "-H 'Content-Type: application/json'",
  "-d " + JSON.stringify(JSON.stringify({ q: Q, language: "hu" })),
  "--max-time 180",
].join(" ");

conn.on("ready", () => {
  conn.exec(curl, (err, stream) => {
    if (err) { console.error("EXEC ERR", err.message); conn.end(); return; }
    let out = "";
    stream.on("close", () => {
      console.log(out.slice(0, 1500));
      conn.end();
    });
    stream.on("data", (d) => { out += d.toString(); });
    stream.stderr.on("data", (d) => { out += d.toString(); });
  });
}).connect({ host: "10.0.3.81", username: "root", password: "tarantula999" });
