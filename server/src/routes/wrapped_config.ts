import type { Express, Request, Response } from "express";
import { readWrappedConfigV7, writeWrappedConfigV7 } from "../storage/wrappedConfigStore";
export type WrappedConfigCtx = {
  repoRoot: string;
};

function requireAdminToken(req: Request, res: Response): boolean {
  const tok = String(req.headers["x-td-admin-token"] || "").trim();
  const expected = String(process.env.TD_ADMIN_TOKEN || "").trim();

  if (!expected) {
    res.status(500).type("text/plain").send("Server missing TD_ADMIN_TOKEN; refusing write.");
    return false;
  }
  if (!tok || tok !== expected) {
    res.status(403).type("text/plain").send("Forbidden");
    return false;
  }
  return true;
}

export function registerWrappedConfigRoutes(app: Express, ctx: WrappedConfigCtx): void {
  app.get("/api/v1/wrapped-config", (_req, res) => {
    try {
      const cfg = readWrappedConfigV7(ctx.repoRoot);
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(cfg);
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "wrapped_config_read_failed", error: String(err) });
    }
  });

  app.put("/api/v1/wrapped-config", async (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;

      const body = req.body;
      if (!body || typeof body !== "object") {
        return res.status(400).type("text/plain").send("Invalid JSON");
      }

      const saved = writeWrappedConfigV7(ctx.repoRoot, body);
      res.setHeader("cache-control", "no-store");
      return res.status(200).json(saved);
    } catch (err) {
      return res.status(500).json({ ok: false, reason: "wrapped_config_write_failed", error: String(err) });
    }
  });
}
