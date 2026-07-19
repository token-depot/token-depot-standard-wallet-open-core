import express from "express";
import {
  calculateEntitlementPackageForAddresses,
  calculateEntitlementPackageForUserIds,
  readEntitlementTokenRaw,
  readEntitlementTokenStore,
  upsertEntitlementTokenRule,
  type EntitlementPackageType,
  type EntitlementTokenRulePatchV1
} from "../storage/entitlementTokenStore";

export type EntitlementTokenAdminCtx = {
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

function numericBodyField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function packageTypeBodyField(value: unknown): EntitlementPackageType | null {
  if (value === "PLUS" || value === "PRO" || value === "TENANT") return value;
  return null;
}

function addressListBodyField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function userIdListBodyField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function rulePatchFromBody(req: express.Request): EntitlementTokenRulePatchV1 {
  const body = bodyObject(req);
  const activeMonths = numericBodyField(body.active_months);
  const graceMonths = numericBodyField(body.grace_months);

  return {
    id: typeof body.id === "string" ? body.id : undefined,
    status: typeof body.status === "string" ? (body.status as EntitlementTokenRulePatchV1["status"]) : undefined,
    owner_scope: typeof body.owner_scope === "string" ? (body.owner_scope as EntitlementTokenRulePatchV1["owner_scope"]) : undefined,
    tenant_id: body.tenant_id === null || typeof body.tenant_id === "string" ? body.tenant_id : undefined,
    brand_id: body.brand_id === null || typeof body.brand_id === "string" ? body.brand_id : undefined,
    package_type: typeof body.package_type === "string" ? (body.package_type as EntitlementTokenRulePatchV1["package_type"]) : undefined,
    trigger_ca: typeof body.trigger_ca === "string" ? body.trigger_ca : undefined,
    trigger_label: typeof body.trigger_label === "string" ? body.trigger_label : undefined,
    seller_address: typeof body.seller_address === "string" ? body.seller_address : undefined,
    active_months: activeMonths,
    grace_months: graceMonths,
    gate_title: typeof body.gate_title === "string" ? body.gate_title : undefined,
    gate_body: typeof body.gate_body === "string" ? body.gate_body : undefined,
    gate_testnet_note: typeof body.gate_testnet_note === "string" ? body.gate_testnet_note : undefined,
    gate_warning: typeof body.gate_warning === "string" ? body.gate_warning : undefined,
    gate_button_label: typeof body.gate_button_label === "string" ? body.gate_button_label : undefined,
    operator_email_enabled: typeof body.operator_email_enabled === "boolean" ? body.operator_email_enabled : undefined,
    operator_email_to: typeof body.operator_email_to === "string" ? body.operator_email_to : undefined,
    operator_email_subject: typeof body.operator_email_subject === "string" ? body.operator_email_subject : undefined,
    operator_email_body: typeof body.operator_email_body === "string" ? body.operator_email_body : undefined
  };
}

export function buildEntitlementTokenAdminRouter(ctx: EntitlementTokenAdminCtx): express.Router {
  const r = express.Router();

  r.get("/list", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const store = readEntitlementTokenStore(ctx.repoRoot);
      return res.json({ ok: true, rules: store.rules, sales: store.sales });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  r.get("/raw", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const raw = readEntitlementTokenRaw(ctx.repoRoot);
      return res.json({ ok: true, ...raw });
    } catch (err) {
      return res.status(500).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  r.post("/rule/upsert", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const rule = upsertEntitlementTokenRule(ctx.repoRoot, rulePatchFromBody(req));
      return res.json({ ok: true, rule });
    } catch (err) {
      return res.status(400).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  r.post("/package/status", (req, res) => {
    try {
      if (!requireAdminToken(req, res)) return;
      const body = bodyObject(req);
      const packageType = packageTypeBodyField(body.package_type);
      const addresses = addressListBodyField(body.addresses);
      const userIds = userIdListBodyField(body.user_ids);
      const asOf = typeof body.as_of === "string" ? body.as_of : undefined;

      if (!packageType) {
        return res.status(400).json({ ok: false, reason: "invalid_package_type" });
      }

      if (addresses.length === 0 && userIds.length === 0) {
        return res.status(400).json({ ok: false, reason: "missing_addresses_or_user_ids" });
      }

      if (addresses.length > 0 && userIds.length > 0) {
        return res.status(400).json({ ok: false, reason: "ambiguous_identity_selector" });
      }

      const status = userIds.length > 0
        ? calculateEntitlementPackageForUserIds(ctx.repoRoot, packageType, userIds, asOf)
        : calculateEntitlementPackageForAddresses(ctx.repoRoot, packageType, addresses, asOf);
      return res.json({ ok: true, status });
    } catch (err) {
      return res.status(400).json({ ok: false, reason: String(err instanceof Error ? err.message : err) });
    }
  });

  return r;
}
