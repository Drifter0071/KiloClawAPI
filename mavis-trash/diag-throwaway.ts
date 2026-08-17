// Diagnostic — just exercise the broken endpoint once.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { startTestServer, authHeaders } from "./harness";
import { buildFixture, cleanupFixture, type FixtureRow } from "./fixtures/fixture";

const rows: FixtureRow[] = [
  { KEY: 1, "BEJELENTÉS SORSZÁMA": "B20010101", "1": "ANDRITZ KFT.", "AKTUÁLIS NÉV": "ANDRITZ KFT.", "NY/Z": 0 },
];

describe("diag", () => {
  let srv: Awaited<ReturnType<typeof startTestServer>>;
  let fix: ReturnType<typeof buildFixture>;

  beforeAll(async () => {
    fix = buildFixture(rows);
    srv = await startTestServer(fix);
  });
  afterAll(() => { srv.stop(); cleanupFixture(fix); });

  test("dump 500 body", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer: { name: "DIAG KFT." },
        devices: ["TMV-400"],
        reported: "készülék nem indul el",
        technician: "TS",
      }),
    });
    const txt = await r.text();
    console.log("STATUS", r.status);
    console.log("BODY", txt);
    expect(r.status).toBe(500);
  });
});
