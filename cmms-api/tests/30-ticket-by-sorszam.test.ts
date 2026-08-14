// 30-ticket-by-sorszam.test.ts
//
// Tests for GET /v1/tickets/by-sorszam/:sorszam — the dedicated
// single-ticket endpoint that powers the v2 dashboard's ticket
// inspector (drawer) and in-place right-column panel. Returns the
// full JobCard so the inspector can show every field the operator
// needs (customer, devices, all notes, technician, kategoria,
// sulyossag, dates) in a single round-trip.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

let fix: Fixture;
let srv: TestServer;
let createdSorszam = "";
let createdKey = 0;

beforeAll(async () => {
  fix = buildFixture([]);
  srv = await startTestServer(fix);

  // Create one ticket with a known shape so the by-sorszam lookup has
  // something to return. The interview-style /v1/tickets endpoint
  // accepts the basic fields directly; the technician + problem +
  // devices are set via their own dedicated sub-endpoints
  // (POST /v1/tickets/:key/{technician,problem,machine}).
  const create = await fetch(`${srv.url}/v1/tickets`, {
    method: "POST",
    headers: authHeaders(srv.writeToken),
    body: JSON.stringify({
      customer_name: "BY-SORSZAM TEST CUST",
    }),
  });
  expect(create.status).toBe(201);
  const card = (await create.json()) as { sorszam: string; key: number };
  createdSorszam = card.sorszam;
  createdKey = card.key;

  // Set the technician + problem + device via the interview endpoints
  // so the resolved JobCard has interesting fields to assert against.
  await fetch(`${srv.url}/v1/tickets/${createdKey}/technician`, {
    method: "POST",
    headers: authHeaders(srv.writeToken),
    body: JSON.stringify({ technician: "TS" }),
  });
  await fetch(`${srv.url}/v1/tickets/${createdKey}/problem`, {
    method: "POST",
    headers: authHeaders(srv.writeToken),
    body: JSON.stringify({ text: "Hibás leolvasás a szenzoron" }),
  });
  await fetch(`${srv.url}/v1/tickets/${createdKey}/machine`, {
    method: "POST",
    headers: authHeaders(srv.writeToken),
    body: JSON.stringify({ devices: ["NCT2000 vezérlő (SN:42)"] }),
  });
});

afterAll(() => {
  srv.stop();
  cleanupFixture(fix);
});

describe("GET /v1/tickets/by-sorszam/:sorszam", () => {
  test("returns the full JobCard for a known sorszam", async () => {
    const r = await fetch(
      `${srv.url}/v1/tickets/by-sorszam/${encodeURIComponent(createdSorszam)}`,
      { headers: authHeaders(srv.readToken) },
    );
    expect(r.status).toBe(200);
    const card = await r.json();
    expect(card.sorszam).toBe(createdSorszam);
    expect(card.key).toBe(createdKey);
    expect(card.customer.name).toBe("BY-SORSZAM TEST CUST");
    expect(card.technician).toBe("TS");
    expect(card.status).toBe("open");
    expect(Array.isArray(card.devices)).toBe(true);
    expect(card.devices.length).toBeGreaterThan(0);
    expect(Array.isArray(card.notes)).toBe(true);
    // The reported note (problem) was added at create time.
    expect(card.notes.some((n: any) => n.kind === "reported" && n.body.includes("szenzoron"))).toBe(true);
  });

  test("strips the internal _haystack field", async () => {
    const r = await fetch(
      `${srv.url}/v1/tickets/by-sorszam/${encodeURIComponent(createdSorszam)}`,
      { headers: authHeaders(srv.readToken) },
    );
    const card = await r.json();
    expect(card._haystack).toBeUndefined();
  });

  test("returns 404 with not_found code for an unknown sorszam", async () => {
    const r = await fetch(
      `${srv.url}/v1/tickets/by-sorszam/B999999999`,
      { headers: authHeaders(srv.readToken) },
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error?.code).toBe("not_found");
  });

  test("URL-decodes percent-encoded sorszams", async () => {
    // The B-prefix sorszams aren't percent-encoded normally, but the
    // endpoint should still tolerate encoding (e.g. from a client that
    // always encodeURIComponents). The same fixture ticket should
    // come back.
    const r = await fetch(
      `${srv.url}/v1/tickets/by-sorszam/${encodeURIComponent(createdSorszam)}`,
      { headers: authHeaders(srv.readToken) },
    );
    expect(r.status).toBe(200);
  });

  test("requires the read bearer token (no auth = 401)", async () => {
    const r = await fetch(
      `${srv.url}/v1/tickets/by-sorszam/${encodeURIComponent(createdSorszam)}`,
    );
    expect(r.status).toBe(401);
  });
});
