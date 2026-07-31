// Interview-style ticket endpoints tests
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

let fix: Fixture;
let srv: TestServer;

beforeAll(async () => {
  fix = buildFixture([]);
  srv = await startTestServer(fix);
});
afterAll(() => {
  srv.stop();
  cleanupFixture(fix);
});

describe("POST /v1/tickets (open_ticket)", () => {
  test("opens ticket with customer name only", async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "TEST CUST" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.key).toBeGreaterThan(0);
    expect(j.sorszam).toBeTruthy();
    expect(j.customer.name).toBe("TEST CUST");
    expect(j.status).toBe("open");
    expect(j.notes.length).toBe(0);
    expect(j.devices.length).toBe(0);
  });

  test("opens ticket with optional fields", async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer_name: "GE Debrecen",
        customer_zip: "4034",
        customer_address: "Faraktár u 107",
        customer_phone: "+36 1 234 5678",
        customer_email: "ge@example.com",
      }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.customer.name).toBe("GE Debrecen");
    expect(j.customer.zip).toBe("4034");
    expect(j.customer.address).toBe("Faraktár u 107");
    expect(j.customer.phone).toBe("+36 1 234 5678");
    expect(j.customer.email).toBe("ge@example.com");
  });

  test("missing customer_name -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("missing_customer");
  });

  test("read token blocked on open_ticket -> 403", async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ customer_name: "X" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("POST /v1/tickets/:key/problem", () => {
  let ticketKey: number;

  beforeAll(async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "PROBLEM TEST" }),
    });
    const j = await r.json();
    ticketKey = j.key;
  });

  test("sets problem description", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/problem`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "készülék nem indul" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.key).toBe(ticketKey);
    expect(j.notes.some((n: any) => n.kind === "reported" && n.body === "készülék nem indul")).toBe(true);
  });

  test("appends additional problem text", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/problem`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "plusz képernyő sötét" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    const reported = j.notes.filter((n: any) => n.kind === "reported");
    expect(reported.length).toBe(2);
    expect(reported[1].body).toBe("plusz képernyő sötét");
  });

  test("missing text -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/problem`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  test("404 for nonexistent key", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/99999/problem`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "x" }),
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /v1/tickets/:key/machine", () => {
  let ticketKey: number;

  beforeAll(async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "MACHINE TEST" }),
    });
    const j = await r.json();
    ticketKey = j.key;
  });

  test("sets device list", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/machine`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ devices: ["NCT2000", "CRT15\"", "SW-1.039"] }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.devices.length).toBe(3);
    expect(j.devices[0].raw).toBe("NCT2000");
    expect(j.devices[0].model).toBe("NCT2000");
    expect(j.devices[1].model).toBe("CRT15");
  });

  test("empty devices -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/machine`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ devices: [] }),
    });
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/tickets/:key/location", () => {
  let ticketKey: number;

  beforeAll(async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "LOCATION TEST" }),
    });
    const j = await r.json();
    ticketKey = j.key;
  });

  test("sets address + zip", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/location`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ address: "Debrecen Faraktár u 107", zip: "4034" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.customer.address).toBe("Debrecen Faraktár u 107");
    expect(j.customer.zip).toBe("4034");
  });
});

describe("POST /v1/tickets/:key/technician", () => {
  let ticketKey: number;

  beforeAll(async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "TECH TEST" }),
    });
    const j = await r.json();
    ticketKey = j.key;
  });

  test("sets technician", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/technician`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ technician: "TP" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.technician).toBe("TP");
  });
});

describe("POST /v1/tickets/:key/solution", () => {
  let ticketKey: number;

  beforeAll(async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "SOLUTION TEST" }),
    });
    const j = await r.json();
    ticketKey = j.key;
  });

  test("sets solution with author", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/solution`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "Tápegység cserélve", author: "TP" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.notes.some((n: any) => n.kind === "work" && n.body === "Tápegység cserélve" && n.author === "TP")).toBe(true);
  });
});

describe("POST /v1/tickets/:key/close", () => {
  let ticketKey: number;

  beforeAll(async () => {
    const r = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "CLOSE TEST" }),
    });
    const j = await r.json();
    ticketKey = j.key;
  });

  test("closes ticket", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/close`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.status).toBe("closed");
  });

  test("cannot close twice (already closed)", async () => {
    const r = await fetch(`${srv.url}/v1/tickets/${ticketKey}/close`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.status).toBe("closed");
  });

  test("closes ticket with solution text", async () => {
    // Open a new ticket for this test
    const open = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "CLOSE WITH SOL" }),
    });
    const created = await open.json();

    const r = await fetch(`${srv.url}/v1/tickets/${created.key}/close`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "Tápegység cserélve", author: "TP" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.status).toBe("closed");
    expect(j.notes.some((n: any) => n.kind === "work" && n.body === "Tápegység cserélve")).toBe(true);
  });
});

describe("Full interview workflow", () => {
  test("complete lifecycle: open → set fields → close", async () => {
    // 1. Open
    const open = await fetch(`${srv.url}/v1/tickets`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "WORKFLOW TEST" }),
    });
    const ticket = await open.json();
    const key = ticket.key;
    expect(ticket.status).toBe("open");

    // 2. Set problem
    const prob = await fetch(`${srv.url}/v1/tickets/${key}/problem`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "NCT2000 nem indul" }),
    });
    expect(prob.status).toBe(201);

    // 3. Set machine
    const mach = await fetch(`${srv.url}/v1/tickets/${key}/machine`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ devices: ["NCT2000"] }),
    });
    expect(mach.status).toBe(201);

    // 4. Set location
    const loc = await fetch(`${srv.url}/v1/tickets/${key}/location`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ address: "Debrecen", zip: "4034" }),
    });
    expect(loc.status).toBe(201);

    // 5. Set technician
    const tech = await fetch(`${srv.url}/v1/tickets/${key}/technician`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ technician: "TP" }),
    });
    expect(tech.status).toBe(201);

    // 6. Set solution
    const sol = await fetch(`${srv.url}/v1/tickets/${key}/solution`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ text: "Tápegység cserélve", author: "TP" }),
    });
    expect(sol.status).toBe(201);

    // 7. Close
    const close = await fetch(`${srv.url}/v1/tickets/${key}/close`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({}),
    });
    expect(close.status).toBe(201);

    // 8. Verify final state
    const final = await fetch(`${srv.url}/v1/jobs/${key}`, {
      headers: authHeaders(srv.readToken),
    });
    const card = await final.json();
    expect(card.status).toBe("closed");
    expect(card.customer.name).toBe("WORKFLOW TEST");
    expect(card.customer.address).toBe("Debrecen");
    expect(card.customer.zip).toBe("4034");
    expect(card.technician).toBe("TP");
    expect(card.devices.some((d: any) => d.model === "NCT2000")).toBe(true);
    expect(card.notes.some((n: any) => n.kind === "reported" && n.body === "NCT2000 nem indul")).toBe(true);
    expect(card.notes.some((n: any) => n.kind === "work" && n.body === "Tápegység cserélve")).toBe(true);
  });
});

describe("POST /v1/tickets/create", () => {
  test("creates ticket with minimal fields (customer_name only)", async () => {
    const res = await fetch(`${srv.url}/v1/tickets/create`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "CREATE MINIMAL" }),
    });
    expect(res.status).toBe(201);
    const card = await res.json();
    expect(card.key).toBeGreaterThan(0);
    expect(card.sorszam).toBeTruthy();
    expect(card.status).toBe("open");
    expect(card.customer.name).toBe("CREATE MINIMAL");
    expect(card.devices).toEqual([]);
    expect(card.notes).toEqual([]);
  });

  test("creates ticket with all fields", async () => {
    const res = await fetch(`${srv.url}/v1/tickets/create`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer_name: "CREATE FULL",
        customer_zip: "1234",
        customer_address: "Test u. 5",
        customer_phone: "+36-30-123-4567",
        customer_email: "full@test.com",
        devices: ["NCT2000", "TMV-400(10297)"],
        reported: "Motor nem indul",
        work: "Szíj cserélve",
        technician: "AB",
        reporter: "Kovács",
        fault_receiver: "Szabó",
        payment: "gar",
        remote_access: "teamviewer",
      }),
    });
    expect(res.status).toBe(201);
    const card = await res.json();
    expect(card.key).toBeGreaterThan(0);
    expect(card.customer.name).toBe("CREATE FULL");
    expect(card.customer.zip).toBe("1234");
    expect(card.customer.address).toBe("Test u. 5");
    expect(card.customer.phone).toBe("+36-30-123-4567");
    expect(card.customer.email).toBe("full@test.com");
    expect(card.status).toBe("open");
    expect(card.technician).toBe("AB");
    expect(card.devices.length).toBe(2);
    expect(card.devices.some((d: any) => d.model === "NCT2000")).toBe(true);
    expect(card.notes.some((n: any) => n.kind === "reported" && n.body === "Motor nem indul")).toBe(true);
    expect(card.notes.some((n: any) => n.kind === "work" && n.body === "Szíj cserélve")).toBe(true);
  });

  test("missing customer_name returns 400", async () => {
    const res = await fetch(`${srv.url}/v1/tickets/create`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ reported: "no customer" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("missing_customer");
  });

  test("read token is blocked", async () => {
    const res = await fetch(`${srv.url}/v1/tickets/create`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ customer_name: "READ BLOCKED" }),
    });
    expect(res.status).toBe(403);
  });

  test("creates closed ticket when status=closed", async () => {
    const res = await fetch(`${srv.url}/v1/tickets/create`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer_name: "CREATE CLOSED", status: "closed" }),
    });
    expect(res.status).toBe(201);
    const card = await res.json();
    expect(card.status).toBe("closed");
  });
});
