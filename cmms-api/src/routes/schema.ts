import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Router } from "express";
import { Router as makeRouter } from "express";

function resolveSchemaPath(): string {
  const binDir = dirname(process.argv[0]);
  const candidates = [
    resolve(binDir, "schema", "schema.json"),
    resolve(process.cwd(), "schema", "schema.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

export function schemaRouter(): Router {
  const r = makeRouter();
  const path = resolveSchemaPath();
  const body = readFileSync(path, "utf-8");
  r.get("/v1/schema", (_req, res) => {
    res.type("application/json").send(body);
  });
  return r;
}
