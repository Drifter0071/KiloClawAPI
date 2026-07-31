// Bearer token middleware. Two tokens:
//   CMMS_API_TOKEN_READ  -> required for every request
//   CMMS_API_TOKEN_WRITE -> additionally required for POST endpoints
//
// Returns 401 if neither token is present, 403 if a write endpoint
// is called with only the read token.

import type { Request, Response, NextFunction } from "express";

export function requireAuth(opts: { write: boolean }) {
  const readToken = process.env.CMMS_API_TOKEN_READ ?? "";
  const writeToken = process.env.CMMS_API_TOKEN_WRITE ?? "";
  if (!readToken) {
    // Fail closed: refuse to start without at least a read token.
    throw new Error("CMMS_API_TOKEN_READ is not set");
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.header("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1] : "";
    if (!token || (token !== readToken && token !== writeToken)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid bearer token" } });
      return;
    }
    if (opts.write) {
      if (!writeToken) {
        res.status(503).json({ error: { code: "write_disabled", message: "CMMS_API_TOKEN_WRITE is not set" } });
        return;
      }
      if (token !== writeToken) {
        res.status(403).json({ error: { code: "forbidden", message: "Write privilege required" } });
        return;
      }
    }
    next();
  };
}

