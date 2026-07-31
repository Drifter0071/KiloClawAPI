// Spin up a fresh test server for a fixture. Returns a base URL and a
// stop() function. Each call opens its own temp cmms.db + cmms_specialized.db
// and runs a full ETL.
import { openDbs } from "../src/db/open";
import { runFullEtl } from "../src/db/etl";
import { JobCache } from "../src/cache/jobs";
import { createApp } from "../src/server";
import type { Fixture } from "./fixtures/fixture";

export type TestServer = {
  url: string;
  stop: () => void;
  readToken: string;
  writeToken: string;
  fixture: Fixture;
};

const READ = "test-read-token";
const WRITE = "test-write-token";

export async function startTestServer(fixture: Fixture): Promise<TestServer> {
  process.env.CMMS_API_TOKEN_READ = READ;
  process.env.CMMS_API_TOKEN_WRITE = WRITE;
  const dbs = openDbs({ cmmsPath: fixture.cmmsPath, specializedPath: fixture.specPath });
  const r = runFullEtl(dbs);
  // Force the spec DB's WAL to be fully merged into the main file so any
  // subsequent reader (including the fresh connection opened by
  // JobCache.buildFromDb) sees the just-committed ETL rows.
  try { dbs.spec.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  const cache = new JobCache();
  cache.buildFromDb(dbs);
  const app = createApp(dbs, cache);
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
