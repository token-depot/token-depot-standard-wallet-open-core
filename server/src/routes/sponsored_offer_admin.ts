import express from "express";
import {
  listSponsoredOffers,
  readSponsoredOfferRaw,
  upsertSponsoredOffer,
  type SponsoredOfferPatchV1
} from "../storage/sponsoredOfferStore";

export type SponsoredOfferAdminCtx = {
  repoRoot: string;
};

function requireAdminToken(req: express.Request, res: express.Response): boolean {
  const tok = String(req.headers["x-td-admin-token"] || "").trim();
  const expected = String(process.env.TD_ADMIN_TOKEN || "").trim();

  if (!expected) {
    res.status(500).json({ ok: false, reason: "server_missing_td_admin_token" });
    return false;
  }

  if (!tok || tok !== expected) {
    res.status(403).json({ ok: false, reason: "forbidden" });
    return false;
  }

  return true;
}

function bodyObject(req: express.Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

function campaignPatchFromBody(req: express.Request): SponsoredOfferPatchV1 {
  const body = bodyObject(req);
  return {
    id: typeof body.id === "string" ? body.id : undefined,
    status: typeof body.status === "string" ? (body.status as SponsoredOfferPatchV1["status"]) : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    body: typeof body.body === "string" ? body.body : undefined,
    cta_label: typeof body.cta_label === "string" ? body.cta_label : undefined,
    destination_url: body.destination_url === null || typeof body.destination_url === "string" ? body.destination_url : undefined,
    placement: typeof body.placement === "string" ? (body.placement as SponsoredOfferPatchV1["placement"]) : undefined,
    audience: typeof body.audience === "string" ? (body.audience as SponsoredOfferPatchV1["audience"]) : undefined,
    priority: typeof body.priority === "number" || typeof body.priority === "string" ? (body.priority as SponsoredOfferPatchV1["priority"]) : undefined,
    active_from: body.active_from === null || typeof body.active_from === "string" ? body.active_from : undefined,
    active_until: body.active_until === null || typeof body.active_until === "string" ? body.active_until : undefined,
    max_impressions_per_day:
      body.max_impressions_per_day === null || typeof body.max_impressions_per_day === "number" || typeof body.max_impressions_per_day === "string"
        ? (body.max_impressions_per_day as SponsoredOfferPatchV1["max_impressions_per_day"])
        : undefined,
    cooldown_minutes:
      body.cooldown_minutes === null || typeof body.cooldown_minutes === "number" || typeof body.cooldown_minutes === "string"
        ? (body.cooldown_minutes as SponsoredOfferPatchV1["cooldown_minutes"])
        : undefined,
    allow_user_block: typeof body.allow_user_block === "boolean" ? body.allow_user_block : undefined,
    brand_id: body.brand_id === null || typeof body.brand_id === "string" ? body.brand_id : undefined,
    tenant_id: body.tenant_id === null || typeof body.tenant_id === "string" ? body.tenant_id : undefined
  };
}

export function buildSponsoredOfferAdminRouter(ctx: SponsoredOfferAdminCtx): express.Router {
  const r = express.Router();

  r.get("/list", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      return res.json({ ok: true, campaigns: listSponsoredOffers(ctx.repoRoot) });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  r.get("/raw", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const raw = readSponsoredOfferRaw(ctx.repoRoot);
      return res.json({ ok: true, ...raw });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  r.post("/upsert", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const campaign = upsertSponsoredOffer(ctx.repoRoot, campaignPatchFromBody(req));
      return res.json({ ok: true, campaign });
    } catch (err) {
      return res.status(400).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  return r;
}
