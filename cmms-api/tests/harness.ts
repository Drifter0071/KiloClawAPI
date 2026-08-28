// Spin up a fresh test server for a fixture. Returns a base URL and a
// stop() function. Each call opens its own temp cmms.db + cmms_specialized.db,
// runs a full ETL, builds the FTS5 RAG index, and starts Express.
import { openDbs, type OpenDbs } from "../src/db/open";
import { runFullEtl } from "../src/db/etl";
import { buildRagIndex, type RagIndex } from "../src/lib/rag";
import { createApp } from "../src/server";
import type { Fixture } from "./fixtures/fixture";

export type TestServer = {
  url: string;
  stop: () => void;
  readToken: string;
  writeToken: string;
  fixture: Fixture;
  rag: RagIndex;
  dbs: OpenDbs;
};

const READ = "test-read-token";
const WRITE = "test-write-token";

export async function startTestServer(fixture: Fixture): Promise<TestServer> {
  process.env.CMMS_API_TOKEN_READ = READ;
  process.env.CMMS_API_TOKEN_WRITE = WRITE;
  // Make sure the LLM is NOT configured for tests unless the test
  // sets it explicitly. We default to "no key" so renderLlmAnswer
  // returns null and the deterministic fallback ships.
  if (process.env.KILO_API_KEY === undefined) delete process.env.KILO_API_KEY;

  const dbs = openDbs({ cmmsPath: fixture.cmmsPath, specializedPath: fixture.specPath });
  runFullEtl(dbs);
  try { dbs.spec.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  const rag = buildRagIndex(dbs);

  const app = createApp(dbs, rag);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((res) => server.once("listening", () => res()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("could not get server address");
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    fixture,
    readToken: READ,
    writeToken: WRITE,
    rag,
    dbs,
    stop: () => {
      server.close();
      try { dbs.cmms.close(); } catch {}
      try { dbs.spec.close(); } catch {}
    },
  };
}

export function authHeaders(token: string, extra: Record<string, string> = {}): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}
