import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import {
  createUser,
  deleteUser,
  findUserByEmail,
  findUserByPhone,
  getUser,
  listUsers,
  makeUserPasswordAuth,
  readUserProfile,
  reassignUsersTenantId,
  saveUserProfile,
  saveUserSkin,
  setUserAuth,
  setUserAuthHash,
  setUserTenantId,
  verifyUserPassword,
  type UserNotificationSettings
} from "../storage/userStore";
import { readUserState, writeUserState } from "../storage/userStateStore";
import { calculateWalletPlusEntitlementForUserIds, listEntitlementTokenRules, type EntitlementPackageType } from "../storage/entitlementTokenStore";
import { readWalletStore } from "../storage/walletStore";
import { clearPasswordReset, getPasswordReset, upsertPasswordReset } from "../storage/passwordResetStore";
import {
  clearEmailAuthCode,
  hashEmailAuthCode,
  makeEmailAuthCode,
  upsertEmailAuthCode,
  verifyEmailAuthCode
} from "../storage/emailAuthCodeStore";
import { clearSessionUserId, readSessionUserId, setSessionUserId, type SessionConfig } from "../auth/session";
import { sendLogin2faEmail, sendPasswordResetEmail, sendProfileEmailChangeVerificationEmail, sendSignupEmails, sendSignupVerificationEmail } from "../email/smtp";

function getBody(req: express.Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object") return {};
  return req.body as Record<string, unknown>;
}

function parseNotificationSettingsPatch(input: unknown): Partial<UserNotificationSettings> | undefined {
  if (!input || typeof input !== "object") return undefined;

  const src = input as Record<string, unknown>;
  return {
    funds_sent: typeof src.funds_sent === "boolean" ? src.funds_sent : undefined,
    whitelist_added: typeof src.whitelist_added === "boolean" ? src.whitelist_added : undefined,
    whitelist_removed: typeof src.whitelist_removed === "boolean" ? src.whitelist_removed : undefined,
    new_offers: typeof src.new_offers === "boolean" ? src.new_offers : undefined,
    maker_offer_created: typeof src.maker_offer_created === "boolean" ? src.maker_offer_created : undefined,
    maker_offer_filled: typeof src.maker_offer_filled === "boolean" ? src.maker_offer_filled : undefined,
    entitlement_purchase: typeof src.entitlement_purchase === "boolean" ? src.entitlement_purchase : undefined,
    wallet_created_standard:
      typeof src.wallet_created_standard === "boolean" ? src.wallet_created_standard : undefined,
    wallet_created_compliance:
      typeof src.wallet_created_compliance === "boolean" ? src.wallet_created_compliance : undefined,
    wallet_deleted: typeof src.wallet_deleted === "boolean" ? src.wallet_deleted : undefined
  };
}

function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  const a = String(aHex || "").trim();
  const b = String(bHex || "").trim();
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;

  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

type IpWindow = { startMs: number; count: number };

const rlSignupByIp: Map<string, IpWindow> = new Map();
const rlPwResetByIp: Map<string, IpWindow> = new Map();
const rlSignupEmailNextAllowedMs: Map<string, number> = new Map();

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function emailHashForLog(email: string, secret: string): string {
  const e = normalizeEmail(email);
  if (!e) return "none";
  return crypto.createHmac("sha256", secret).update(e, "utf8").digest("hex");
}

function clientIpForRateLimit(req: express.Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0] ? String(xff.split(",")[0]).trim() : "";
    if (first) return first.startsWith("::ffff:") ? first.slice(7) : first;
  }

  const xri = req.headers["x-real-ip"];
  if (typeof xri === "string" && xri.trim()) {
    const ip = xri.trim();
    return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  }

  const ra = (req.socket && req.socket.remoteAddress) ? String(req.socket.remoteAddress) : "";
  if (ra.startsWith("::ffff:")) return ra.slice(7);
  return ra || "unknown";
}

function rateLimitIpWindow(
  m: Map<string, IpWindow>,
  ip: string,
  nowMs: number,
  windowMs: number,
  maxPerWindow: number
): boolean {
  const key = ip || "unknown";
  const prev = m.get(key);

  if (!prev || nowMs - prev.startMs >= windowMs) {
    m.set(key, { startMs: nowMs, count: 1 });
    return false;
  }

  if (prev.count >= maxPerWindow) return true;

  m.set(key, { ...prev, count: prev.count + 1 });
  return false;
}

function rateLimitLog(endpoint: string, ip: string, emailHash: string): void {
  console.log(`[rate_limited] endpoint=${endpoint} ip=${ip} email_hash=${emailHash}`);
}

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

function isFrozen(repoRoot: string, userId: string): boolean {
  return readUserState(repoRoot, userId).account_frozen === true;
}

function gcEmailCooldownMap(m: Map<string, number>, nowMs: number): void {
  if (m.size <= 2000) return;
  for (const [k, v] of m.entries()) {
    if (nowMs >= v) m.delete(k);
  }
}

function atomicWriteJsonLocal(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function saveNotificationOnlyProfile(
  repoRoot: string,
  userId: string,
  notificationDestination: string | undefined,
  notifications: Partial<UserNotificationSettings> | undefined
) {
  const existing = readUserProfile(repoRoot, userId);
  const existingNotifications = existing.notifications || {
    funds_sent: false,
    whitelist_added: false,
    whitelist_removed: false,
    new_offers: false,
    maker_offer_created: false,
    maker_offer_filled: false,
    entitlement_purchase: false,
    wallet_created_standard: false,
    wallet_created_compliance: false,
    wallet_deleted: false
  };

  const next = {
    ...existing,
    notification_destination:
      typeof notificationDestination === "string"
        ? (notificationDestination.trim() || undefined)
        : existing.notification_destination,
    notifications: {
      funds_sent:
        typeof notifications?.funds_sent === "boolean" ? notifications.funds_sent : existingNotifications.funds_sent,
      whitelist_added:
        typeof notifications?.whitelist_added === "boolean"
          ? notifications.whitelist_added
          : existingNotifications.whitelist_added,
      whitelist_removed:
        typeof notifications?.whitelist_removed === "boolean"
          ? notifications.whitelist_removed
          : existingNotifications.whitelist_removed,
      new_offers:
        typeof notifications?.new_offers === "boolean" ? notifications.new_offers : existingNotifications.new_offers,
      maker_offer_created:
        typeof notifications?.maker_offer_created === "boolean"
          ? notifications.maker_offer_created
          : existingNotifications.maker_offer_created,
      maker_offer_filled:
        typeof notifications?.maker_offer_filled === "boolean"
          ? notifications.maker_offer_filled
          : existingNotifications.maker_offer_filled,
      entitlement_purchase:
        typeof notifications?.entitlement_purchase === "boolean"
          ? notifications.entitlement_purchase
          : existingNotifications.entitlement_purchase,
      wallet_created_standard:
        typeof notifications?.wallet_created_standard === "boolean"
          ? notifications.wallet_created_standard
          : existingNotifications.wallet_created_standard,
      wallet_created_compliance:
        typeof notifications?.wallet_created_compliance === "boolean"
          ? notifications.wallet_created_compliance
          : existingNotifications.wallet_created_compliance,
      wallet_deleted:
        typeof notifications?.wallet_deleted === "boolean"
          ? notifications.wallet_deleted
          : existingNotifications.wallet_deleted
    },
    updated_at: new Date().toISOString()
  };

  atomicWriteJsonLocal(path.join(repoRoot, "data", "users", userId, "profile.json"), next);
  return readUserProfile(repoRoot, userId);
}

export type SignupTenantResolution =
  | { ok: true; tenant_id: string | null; tenant_signup_notify_email?: string | null }
  | { ok: false; status: number; reason: string };

export type SignupTenantResolver = (req: express.Request) => Promise<SignupTenantResolution>;

export type V1PublicRouterOptions = {
  resolveSignupTenant?: SignupTenantResolver;
};

export function buildV1PublicRouter(
  repoRoot: string,
  sessionCfg: SessionConfig,
  options: V1PublicRouterOptions = {}
): express.Router {
  const r = express.Router();

  function ensureDevUsers(res: express.Response): boolean {
    if (process.env.TD_DEV_USERS !== "1") {
      res.status(404).json({ ok: false, reason: "not_found" });
      return false;
    }
    return true;
  }

  r.get("/session/me", (req, res) => {
    const userId = readSessionUserId(req, sessionCfg);
    if (userId && isFrozen(repoRoot, userId)) {
      clearSessionUserId(res, sessionCfg);
      return res.json({ ok: true, user_id: null, tenant_id: null });
    }

    const u = userId ? getUser(repoRoot, userId) : null;
    return res.json({
      ok: true,
      user_id: userId,
      tenant_id: u?.tenant_id ?? null
    });
  });

  r.post("/session/select-user", (req, res) => {
    if (!ensureDevUsers(res)) return;

    const body = getBody(req);
    const user_id = body.user_id;

    if (typeof user_id !== "string" || !user_id.trim()) {
      return res.json({ ok: false, reason: "missing_user_id" });
    }

    const u = getUser(repoRoot, user_id.trim());
    if (!u) {
      return res.json({ ok: false, reason: "user_not_found" });
    }

    if (isFrozen(repoRoot, u.id)) {
      clearSessionUserId(res, sessionCfg);
      return res.status(403).json({ ok: false, reason: "account_frozen" });
    }

    setSessionUserId(res, u.id, sessionCfg);
    return res.json({ ok: true, user_id: u.id, label: u.label });
  });

  r.post("/session/logout", (_req, res) => {
    clearSessionUserId(res, sessionCfg);
    return res.json({ ok: true });
  });

  r.post("/session/login", async (req, res) => {
    const body = getBody(req);
    const email = body.email;
    const password = body.password;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ ok: false, reason: "missing_email" });
    }
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ ok: false, reason: "missing_password" });
    }

    const emailNorm = normalizeEmail(email);
    const u = findUserByEmail(repoRoot, emailNorm);
    if (!u) {
      return res.status(401).json({ ok: false, reason: "invalid_credentials" });
    }

    const pwOk = verifyUserPassword(u, password);
    if (!pwOk) {
      return res.status(401).json({ ok: false, reason: "invalid_credentials" });
    }

    if (isFrozen(repoRoot, u.id)) {
      clearSessionUserId(res, sessionCfg);
      return res.status(403).json({ ok: false, reason: "account_frozen" });
    }

    const code = makeEmailAuthCode();
    const now = Date.now();
    const ttlMs = 10 * 60 * 1000;
    const emailIp = typeof req.ip === "string" ? req.ip : null;

    upsertEmailAuthCode(repoRoot, {
      purpose: "login",
      email: emailNorm,
      user_id: u.id,
      code_hash_hex: hashEmailAuthCode(code),
      expires_at_ms: now + ttlMs,
      created_at_ms: now,
      last_send_at_ms: now,
      attempts: 0,
      pending_signup: null
    });

    try {
      await sendLogin2faEmail({
        email: emailNorm,
        code,
        minutesValid: 10,
        ip: emailIp
      });
    } catch (err) {
      clearEmailAuthCode(repoRoot, "login", emailNorm);
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(502).json({ ok: false, reason: msg || "login_2fa_email_failed" });
    }

    return res.json({
      ok: true,
      two_factor_required: true,
      email: emailNorm,
      expires_in_seconds: Math.floor(ttlMs / 1000)
    });
  });

  r.post("/session/login/verify", (req, res) => {
    const body = getBody(req);
    const email = body.email;
    const code = body.code;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ ok: false, reason: "missing_email" });
    }
    if (typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ ok: false, reason: "missing_code" });
    }

    const emailNorm = normalizeEmail(email);
    const verified = verifyEmailAuthCode(repoRoot, "login", emailNorm, code.trim());
    if (!verified.ok) return res.status(400).json({ ok: false, reason: verified.reason });

    const u = findUserByEmail(repoRoot, emailNorm);
    if (!u) {
      clearEmailAuthCode(repoRoot, "login", emailNorm);
      clearSessionUserId(res, sessionCfg);
      return res.status(401).json({ ok: false, reason: "invalid_credentials" });
    }

    if (verified.record.user_id !== u.id) {
      clearEmailAuthCode(repoRoot, "login", emailNorm);
      clearSessionUserId(res, sessionCfg);
      return res.status(401).json({ ok: false, reason: "invalid_credentials" });
    }

    if (isFrozen(repoRoot, u.id)) {
      clearEmailAuthCode(repoRoot, "login", emailNorm);
      clearSessionUserId(res, sessionCfg);
      return res.status(403).json({ ok: false, reason: "account_frozen" });
    }

    clearEmailAuthCode(repoRoot, "login", emailNorm);
    setSessionUserId(res, u.id, sessionCfg);
    return res.json({ ok: true, user_id: u.id, label: u.label });
  });

  r.post("/signup/request", async (req, res) => {
    const body = getBody(req);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const wants = body.wants_license === true;

    if (!name) return res.status(400).json({ ok: false, reason: "missing_name" });
    if (!email) return res.status(400).json({ ok: false, reason: "missing_email" });
    if (!phone) return res.status(400).json({ ok: false, reason: "missing_phone" });
    if (!password) return res.status(400).json({ ok: false, reason: "missing_password" });

    const endpoint = "/api/v1/signup/request";
    const ip = clientIpForRateLimit(req);
    const emailHash = emailHashForLog(email, sessionCfg.secret);
    const nowMs = Date.now();

    const ipLimited = rateLimitIpWindow(rlSignupByIp, ip, nowMs, 60_000, 3);
    if (ipLimited) {
      rateLimitLog(endpoint, ip, emailHash);
      return res.json({ ok: true });
    }

    // deterministic reject before creating anything
    if (findUserByEmail(repoRoot, email)) return res.status(409).json({ ok: false, reason: "email_in_use" });
    if (findUserByPhone(repoRoot, phone)) return res.status(409).json({ ok: false, reason: "phone_in_use" });

    const emailNorm = normalizeEmail(email);
    const nextAllowedMs = rlSignupEmailNextAllowedMs.get(emailNorm) || 0;
    if (nowMs < nextAllowedMs) {
      rateLimitLog(endpoint, ip, emailHash);
      return res.json({ ok: true });
    }

    let signupTenantId: string | null = null;
    let tenantSignupNotifyEmail: string | null = null;
    if (options.resolveSignupTenant) {
      const tenantResolution = await options.resolveSignupTenant(req);
      if (!tenantResolution.ok) {
        return res.status(tenantResolution.status).json({ ok: false, reason: tenantResolution.reason });
      }
      signupTenantId = tenantResolution.tenant_id;
      tenantSignupNotifyEmail = signupTenantId && typeof tenantResolution.tenant_signup_notify_email === "string"
        ? tenantResolution.tenant_signup_notify_email.trim()
        : null;

      if (signupTenantId && !tenantSignupNotifyEmail) {
        return res.status(503).json({ ok: false, reason: "tenant_signup_email_missing" });
      }
    }

    let passwordAuth;
    try {
      passwordAuth = makeUserPasswordAuth(password);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(400).json({ ok: false, reason: msg || "invalid_password" });
    }

    const code = makeEmailAuthCode();
    const now = Date.now();
    const ttlMs = 10 * 60 * 1000;
    const emailIp = typeof req.ip === "string" ? req.ip : null;

    upsertEmailAuthCode(repoRoot, {
      purpose: "signup",
      email: emailNorm,
      user_id: null,
      code_hash_hex: hashEmailAuthCode(code),
      expires_at_ms: now + ttlMs,
      created_at_ms: now,
      last_send_at_ms: now,
      attempts: 0,
      pending_signup: {
        name,
        email: emailNorm,
        phone,
        wants_license: wants,
        password_algo: passwordAuth.password_algo,
        password_salt_hex: passwordAuth.password_salt_hex,
        password_hash_hex: passwordAuth.password_hash_hex,
        tenant_id: signupTenantId,
        tenant_signup_notify_email: tenantSignupNotifyEmail,
        ip: emailIp
      }
    });

    try {
      await sendSignupVerificationEmail({
        email: emailNorm,
        code,
        minutesValid: 10,
        name,
        ip: emailIp
      });
    } catch (err) {
      clearEmailAuthCode(repoRoot, "signup", emailNorm);
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(502).json({ ok: false, reason: msg || "signup_verification_email_failed" });
    }

    const signupSuccessMs = Date.now();
    rlSignupEmailNextAllowedMs.set(emailNorm, signupSuccessMs + 10 * 60 * 1000);
    gcEmailCooldownMap(rlSignupEmailNextAllowedMs, signupSuccessMs);

    return res.json({
      ok: true,
      email_verification_required: true,
      email: emailNorm,
      expires_in_seconds: Math.floor(ttlMs / 1000)
    });
  });

  r.post("/signup/verify", async (req, res) => {
    const body = getBody(req);

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!email) return res.status(400).json({ ok: false, reason: "missing_email" });
    if (!code) return res.status(400).json({ ok: false, reason: "missing_code" });

    const emailNorm = normalizeEmail(email);
    const verified = verifyEmailAuthCode(repoRoot, "signup", emailNorm, code);
    if (!verified.ok) return res.status(400).json({ ok: false, reason: verified.reason });

    const pending = verified.record.pending_signup;
    if (!pending) return res.status(400).json({ ok: false, reason: "signup_pending_missing" });

    if (findUserByEmail(repoRoot, emailNorm)) return res.status(409).json({ ok: false, reason: "email_in_use" });
    if (findUserByPhone(repoRoot, pending.phone)) return res.status(409).json({ ok: false, reason: "phone_in_use" });

    const label = pending.name.length > 64 ? pending.name.slice(0, 64).trim() : pending.name;
    let createdUserId: string | null = null;

    try {
      const u = createUser(repoRoot, label || "Customer");
      createdUserId = u.id;

      if (pending.tenant_id) {
        setUserTenantId(repoRoot, u.id, pending.tenant_id);
      }

      saveUserProfile(repoRoot, u.id, {
        email: emailNorm,
        phone: pending.phone,
        first_name: pending.name
      });

      setUserAuthHash(repoRoot, u.id, {
        password_algo: pending.password_algo,
        password_salt_hex: pending.password_salt_hex,
        password_hash_hex: pending.password_hash_hex
      });

      await sendSignupEmails({
        userId: u.id,
        name: pending.name,
        email: emailNorm,
        phone: pending.phone,
        wantsLicense: pending.wants_license,
        tenantSignupNotifyEmail: pending.tenant_signup_notify_email,
        ip: pending.ip
      });

      clearEmailAuthCode(repoRoot, "signup", emailNorm);

      const signupSuccessMs = Date.now();
      rlSignupEmailNextAllowedMs.set(emailNorm, signupSuccessMs + 10 * 60 * 1000);
      gcEmailCooldownMap(rlSignupEmailNextAllowedMs, signupSuccessMs);

      return res.json({ ok: true, user_id: u.id, label: u.label });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      const reason = msg || "signup_verify_failed";

      if (createdUserId) {
        try {
          deleteUser(repoRoot, createdUserId);
        } catch {
          // best-effort rollback only; do not mask primary error
        }
      }

      if (reason === "email_in_use" || reason === "phone_in_use") return res.status(409).json({ ok: false, reason });

      return res.status(502).json({ ok: false, reason });
    }
  });

  r.post("/password/reset/request", async (req, res) => {
    const body = getBody(req);

    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) return res.status(400).json({ ok: false, reason: "missing_email" });

    const endpoint = "/api/v1/password/reset/request";
    const ip = clientIpForRateLimit(req);
    const emailHash = emailHashForLog(email, sessionCfg.secret);
    const now = Date.now();

    const ipLimited = rateLimitIpWindow(rlPwResetByIp, ip, now, 60_000, 6);
    if (ipLimited) {
      rateLimitLog(endpoint, ip, emailHash);
      return res.json({ ok: true });
    }

    const u = findUserByEmail(repoRoot, email);

    // Only send emails to registered users. Always return ok=true to avoid enumeration.
    if (!u) return res.json({ ok: true });

    const ttlMs = 10 * 60 * 1000;
    const cooldownMs = 60 * 1000;

    const existing = getPasswordReset(repoRoot, email);
    if (existing && now - existing.last_send_at_ms < cooldownMs) {
      rateLimitLog(endpoint, ip, emailHash);
      return res.json({ ok: true });
    }

    const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
    const codeHashHex = crypto.createHash("sha256").update(code).digest("hex");

    upsertPasswordReset(repoRoot, email, codeHashHex, now + ttlMs, now);

    await sendPasswordResetEmail({
      email,
      code,
      minutesValid: 10,
      ip: typeof req.ip === "string" ? req.ip : null
    });

    return res.json({ ok: true });
  });

  r.post("/password/reset/confirm", (req, res) => {
    const body = getBody(req);

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";

    if (!email) return res.status(400).json({ ok: false, reason: "missing_email" });
    if (!code) return res.status(400).json({ ok: false, reason: "missing_code" });
    if (!newPassword) return res.status(400).json({ ok: false, reason: "missing_password" });

    const u = findUserByEmail(repoRoot, email);
    const rset = getPasswordReset(repoRoot, email);
    if (!u || !rset) return res.status(400).json({ ok: false, reason: "invalid_code" });

    const now = Date.now();
    if (rset.expires_at_ms <= now) {
      clearPasswordReset(repoRoot, email);
      return res.status(400).json({ ok: false, reason: "code_expired" });
    }

    if (!/^[0-9]{8}$/.test(code)) return res.status(400).json({ ok: false, reason: "invalid_code" });

    const codeHashHex = crypto.createHash("sha256").update(code).digest("hex");
    if (!timingSafeEqualHex(codeHashHex, rset.code_hash_hex)) return res.status(400).json({ ok: false, reason: "invalid_code" });

    try {
      setUserAuth(repoRoot, u.id, newPassword);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      const reason = msg || "password_reset_failed";
      return res.status(400).json({ ok: false, reason });
    }

    clearPasswordReset(repoRoot, email);
    return res.json({ ok: true });
  });

  function requireSession(res: express.Response, req: express.Request): string | null {
    const userId = readSessionUserId(req, sessionCfg);
    if (!userId) {
      res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
      return null;
    }

    if (isFrozen(repoRoot, userId)) {
      clearSessionUserId(res, sessionCfg);
      res.status(401).json({ ok: false, reason: "account_frozen", login: "/login.html" });
      return null;
    }

    return userId;
  }

  function recipientPolicyPath(repoRoot: string): string {
    return path.join(repoRoot, "..", "Compliance_Node", "data", "policy", "recipient_policy.json");
  }

  function readBrokerIdFromPolicy(repoRoot: string): { broker_id: string | null; warnings: string[] } {
    const warnings: string[] = [];
    try {
      const raw = fs.readFileSync(recipientPolicyPath(repoRoot), "utf8");
      const parsed: any = JSON.parse(raw);
      const id = typeof parsed?.broker_id === "string" ? parsed.broker_id.trim() : "";
      if (!id) warnings.push("broker_id_missing");
      return { broker_id: id || null, warnings };
    } catch {
      warnings.push("broker_policy_unavailable");
      return { broker_id: null, warnings };
    }
  }

  function cnApiGetJson(pathname: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { method: "GET", hostname: "127.0.0.1", port: 8081, path: pathname },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");

            const sc = Number(res.statusCode || 0);
            if (sc >= 200 && sc < 300) {
              try {
                resolve(JSON.parse(body || "{}"));
              } catch {
                reject(new Error("cn_pubkey_parse_failed"));
              }
              return;
            }

            reject(new Error("cn_pubkey_http_" + String(sc)));
          });
        }
      );

      req.on("error", (e) => reject(e));
      req.end();
    });
  }

  async function readCnPubkeyFromCnLocal(): Promise<{ broker_pubkey: string | null; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const j: any = await cnApiGetJson("/api/cn/pubkey");
      const pk = typeof j?.cn_pubkey === "string" ? j.cn_pubkey.trim() : "";
      if (!pk) warnings.push("cn_pubkey_missing");
      return { broker_pubkey: pk || null, warnings };
    } catch {
      warnings.push("cn_pubkey_unavailable");
      return { broker_pubkey: null, warnings };
    }
  }

  function normalizeGateMessagePackageType(value: unknown): EntitlementPackageType | null {
    const s = typeof value === "string" ? value.trim().toUpperCase() : "";
    return s === "PRO" ? "PRO" : null;
  }

  r.get("/entitlement-token-settings/gate-message", (req, res) => {
    if (!requireSession(res, req)) return;

    const packageType = normalizeGateMessagePackageType(req.query.package_type);
    if (!packageType) {
      return res.status(400).json({ ok: false, reason: "package_type_required" });
    }

    try {
      const rule = listEntitlementTokenRules(repoRoot)
        .filter((r) => r.status === "active")
        .find((r) =>
          r.package_type === packageType &&
          r.owner_scope === "broker" &&
          !r.tenant_id &&
          !r.brand_id
        );

      if (!rule) {
        return res.status(404).json({ ok: false, reason: "gate_message_rule_not_found" });
      }

      return res.json({
        ok: true,
        package_type: packageType,
        gate_message: {
          gate_title: rule.gate_title,
          gate_body: rule.gate_body,
          gate_testnet_note: rule.gate_testnet_note,
          gate_warning: rule.gate_warning,
          gate_button_label: rule.gate_button_label
        }
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg });
    }
  });

  r.get("/entitlement-token-settings/upgrade-catalog", (req, res) => {
    const userId = requireSession(res, req);
    if (!userId) return;

    try {
      const user = getUser(repoRoot, userId);
      const userTenantId = typeof user?.tenant_id === "string" ? user.tenant_id.trim() : "";

      const catalog = listEntitlementTokenRules(repoRoot)
        .filter((rule) => {
          if (rule.status !== "active") return false;
          if (rule.network !== "mainnet") return false;
          if (rule.package_type !== "PLUS" && rule.package_type !== "PRO" && rule.package_type !== "TENANT") return false;

          if (rule.owner_scope === "broker") {
            return !rule.tenant_id && !rule.brand_id;
          }

          if (rule.owner_scope === "tenant") {
            return Boolean(userTenantId) && rule.tenant_id === userTenantId && !rule.brand_id;
          }

          return false;
        })
        .map((rule) => ({
          id: rule.id,
          owner_scope: rule.owner_scope,
          package_type: rule.package_type,
          network: rule.network,
          trigger_ca: rule.trigger_ca,
          trigger_label: rule.trigger_label,
          seller_address: rule.seller_address
        }));

      return res.json({
        ok: true,
        catalog
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg });
    }
  });

  r.get("/profile/me", async (req, res) => {
    const userId = requireSession(res, req);
    if (!userId) return;

    try {
      const profile = readUserProfile(repoRoot, userId);
      const walletPlus = calculateWalletPlusEntitlementForUserIds(repoRoot, [userId], profile.skin_id);
      const a = readBrokerIdFromPolicy(repoRoot);
      const b = await readCnPubkeyFromCnLocal();
      const warnings = a.warnings.concat(b.warnings);

      return res.json({
        ok: true,
        user: profile,
        wallet_plus: walletPlus,
        broker: { broker_id: a.broker_id, broker_pubkey: b.broker_pubkey },
        warnings
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg });
    }
  });

  r.post("/profile/save", async (req, res) => {
    const userId = requireSession(res, req);
    if (!userId) return;

    const body = getBody(req);
    const existing = readUserProfile(repoRoot, userId);

    const notificationDestination =
      typeof body.notification_destination === "string" ? body.notification_destination : existing.notification_destination;
    const notifications = parseNotificationSettingsPatch(body.notifications);

    const skinOnlySave =
      Object.prototype.hasOwnProperty.call(body, "skin_id") &&
      !Object.prototype.hasOwnProperty.call(body, "notification_destination") &&
      !Object.prototype.hasOwnProperty.call(body, "notifications") &&
      !Object.prototype.hasOwnProperty.call(body, "email") &&
      !Object.prototype.hasOwnProperty.call(body, "phone") &&
      !Object.prototype.hasOwnProperty.call(body, "first_name") &&
      !Object.prototype.hasOwnProperty.call(body, "last_name") &&
      !Object.prototype.hasOwnProperty.call(body, "address") &&
      !Object.prototype.hasOwnProperty.call(body, "city") &&
      !Object.prototype.hasOwnProperty.call(body, "region") &&
      !Object.prototype.hasOwnProperty.call(body, "postal_code") &&
      !Object.prototype.hasOwnProperty.call(body, "country");

    if (skinOnlySave) {
      try {
        const next = saveUserSkin(repoRoot, userId, body.skin_id);
        return res.json({ ok: true, user: next });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        return res.status(500).json({ ok: false, reason: msg || "unknown_error" });
      }
    }

    const notificationOnlySave =
      (Object.prototype.hasOwnProperty.call(body, "notification_destination") ||
        Object.prototype.hasOwnProperty.call(body, "notifications")) &&
      !Object.prototype.hasOwnProperty.call(body, "skin_id") &&
      !Object.prototype.hasOwnProperty.call(body, "email") &&
      !Object.prototype.hasOwnProperty.call(body, "phone") &&
      !Object.prototype.hasOwnProperty.call(body, "first_name") &&
      !Object.prototype.hasOwnProperty.call(body, "last_name") &&
      !Object.prototype.hasOwnProperty.call(body, "address") &&
      !Object.prototype.hasOwnProperty.call(body, "city") &&
      !Object.prototype.hasOwnProperty.call(body, "region") &&
      !Object.prototype.hasOwnProperty.call(body, "postal_code") &&
      !Object.prototype.hasOwnProperty.call(body, "country");

    if (notificationOnlySave) {
      try {
        const next = saveNotificationOnlyProfile(
          repoRoot,
          userId,
          notificationDestination,
          notifications
        );
        return res.json({ ok: true, user: next });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        return res.status(500).json({ ok: false, reason: msg || "unknown_error" });
      }
    }

    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim()
        : String(existing.email || "").trim();
    const phone =
      typeof body.phone === "string" && body.phone.trim()
        ? body.phone.trim()
        : String(existing.phone || "").trim();

    if (!email) {
      return res.status(400).json({ ok: false, reason: "missing_email" });
    }
    if (!phone) {
      return res.status(400).json({ ok: false, reason: "missing_phone" });
    }

    const emailNorm = normalizeEmail(email);
    const existingEmailNorm = normalizeEmail(String(existing.email || ""));

    const profilePatch = {
      email: emailNorm,
      phone,

      first_name: typeof body.first_name === "string" ? body.first_name : existing.first_name,
      last_name: typeof body.last_name === "string" ? body.last_name : existing.last_name,
      address: typeof body.address === "string" ? body.address : existing.address,
      city: typeof body.city === "string" ? body.city : existing.city,
      region: typeof body.region === "string" ? body.region : existing.region,
      postal_code: typeof body.postal_code === "string" ? body.postal_code : existing.postal_code,
      country: typeof body.country === "string" ? body.country : existing.country,

      notification_destination: notificationDestination,
      notifications
    };

    if (emailNorm !== existingEmailNorm) {
      const found = findUserByEmail(repoRoot, emailNorm);
      if (found && found.id !== userId) return res.status(409).json({ ok: false, reason: "email_in_use" });

      const code = makeEmailAuthCode();
      const now = Date.now();
      const ttlMs = 10 * 60 * 1000;
      const emailIp = typeof req.ip === "string" ? req.ip : null;

      upsertEmailAuthCode(repoRoot, {
        purpose: "profile_email",
        email: emailNorm,
        user_id: userId,
        code_hash_hex: hashEmailAuthCode(code),
        expires_at_ms: now + ttlMs,
        created_at_ms: now,
        last_send_at_ms: now,
        attempts: 0,
        pending_signup: null,
        pending_profile_email_change: {
          email: profilePatch.email,
          phone: profilePatch.phone,
          first_name: profilePatch.first_name ?? null,
          last_name: profilePatch.last_name ?? null,
          address: profilePatch.address ?? null,
          city: profilePatch.city ?? null,
          region: profilePatch.region ?? null,
          postal_code: profilePatch.postal_code ?? null,
          country: profilePatch.country ?? null,
          notification_destination: typeof profilePatch.notification_destination === "string" ? profilePatch.notification_destination : null,
          notifications: profilePatch.notifications ? { ...profilePatch.notifications } : null,
          ip: emailIp
        }
      });

      try {
        await sendProfileEmailChangeVerificationEmail({
          email: emailNorm,
          code,
          minutesValid: 10,
          ip: emailIp
        });
      } catch (err) {
        clearEmailAuthCode(repoRoot, "profile_email", emailNorm);
        const msg = String(err instanceof Error ? err.message : err);
        return res.status(502).json({ ok: false, reason: msg || "profile_email_verification_email_failed" });
      }

      return res.json({
        ok: true,
        email_verification_required: true,
        email: emailNorm,
        expires_in_seconds: Math.floor(ttlMs / 1000)
      });
    }

    try {
      const next = saveUserProfile(repoRoot, userId, profilePatch);

      return res.json({ ok: true, user: next });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      const reason = msg || "unknown_error";

      if (reason === "email_in_use") return res.status(409).json({ ok: false, reason });
      if (reason === "missing_email" || reason === "missing_phone") return res.status(400).json({ ok: false, reason });

      return res.status(500).json({ ok: false, reason });
    }
  });

  r.post("/profile/email/verify", (req, res) => {
    const userId = requireSession(res, req);
    if (!userId) return;

    const body = getBody(req);
    const email = body.email;
    const code = body.code;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ ok: false, reason: "missing_email" });
    }
    if (typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ ok: false, reason: "missing_code" });
    }

    const emailNorm = normalizeEmail(email);
    const verified = verifyEmailAuthCode(repoRoot, "profile_email", emailNorm, code.trim());
    if (!verified.ok) return res.status(400).json({ ok: false, reason: verified.reason });

    if (verified.record.user_id !== userId) {
      clearEmailAuthCode(repoRoot, "profile_email", emailNorm);
      return res.status(403).json({ ok: false, reason: "forbidden" });
    }

    const pending = verified.record.pending_profile_email_change;
    if (!pending) {
      clearEmailAuthCode(repoRoot, "profile_email", emailNorm);
      return res.status(400).json({ ok: false, reason: "pending_profile_email_change_missing" });
    }

    const found = findUserByEmail(repoRoot, emailNorm);
    if (found && found.id !== userId) {
      clearEmailAuthCode(repoRoot, "profile_email", emailNorm);
      return res.status(409).json({ ok: false, reason: "email_in_use" });
    }

    try {
      const next = saveUserProfile(repoRoot, userId, {
        email: pending.email,
        phone: pending.phone,

        first_name: pending.first_name ?? undefined,
        last_name: pending.last_name ?? undefined,
        address: pending.address ?? undefined,
        city: pending.city ?? undefined,
        region: pending.region ?? undefined,
        postal_code: pending.postal_code ?? undefined,
        country: pending.country ?? undefined,

        notification_destination: pending.notification_destination ?? undefined,
        notifications: pending.notifications ? (pending.notifications as Partial<UserNotificationSettings>) : undefined
      });

      clearEmailAuthCode(repoRoot, "profile_email", emailNorm);
      return res.json({ ok: true, user: next });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      const reason = msg || "unknown_error";

      if (reason === "email_in_use") return res.status(409).json({ ok: false, reason });
      if (reason === "missing_email" || reason === "missing_phone") return res.status(400).json({ ok: false, reason });

      return res.status(500).json({ ok: false, reason });
    }
  });

  r.post("/profile/password", (req, res) => {
    const userId = requireSession(res, req);
    if (!userId) return;

    const body = getBody(req);
    const current = body.current_password;
    const next = body.new_password;

    if (typeof current !== "string" || !current) {
      return res.status(400).json({ ok: false, reason: "missing_current_password" });
    }
    if (typeof next !== "string" || !next) {
      return res.status(400).json({ ok: false, reason: "missing_new_password" });
    }

    const u = getUser(repoRoot, userId);
    if (!u) {
      clearSessionUserId(res, sessionCfg);
      return res.status(401).json({ ok: false, reason: "user_not_found", login: "/login.html" });
    }

    const ok = verifyUserPassword(u, current);
    if (!ok) {
      return res.status(401).json({ ok: false, reason: "invalid_current_password" });
    }

    try {
      setUserAuth(repoRoot, userId, next);
      return res.json({ ok: true });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(400).json({ ok: false, reason: msg || "password_update_failed" });
    }
  });

  r.get("/users/list", (_req, res) => {
    if (!ensureDevUsers(res)) return;
    const items = listUsers(repoRoot).map((u) => ({
      id: u.id,
      label: u.label,
      created_at: u.created_at,
      email: u.email ?? null
    }));
    return res.json({ ok: true, items });
  });

  r.post("/users/create", (req, res) => {
    if (!ensureDevUsers(res)) return;
    const body = getBody(req);
    const label = body.label;

    if (typeof label !== "string" || !label.trim()) {
      return res.json({ ok: false, reason: "missing_label" });
    }

    try {
      const u = createUser(repoRoot, label);
      return res.json({ ok: true, user_id: u.id, label: u.label });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.json({ ok: false, reason: msg });
    }
  });

  r.get("/users/admin/list", (req, res) => {
    if (!requireAdminToken(req, res)) return;

    try {
      const items = listUsers(repoRoot).map((u) => {
        const profile = readUserProfile(repoRoot, u.id);
        const state = readUserState(repoRoot, u.id);
        const walletStore = readWalletStore(repoRoot, u.id);

        return {
          id: u.id,
          label: u.label,
          created_at: u.created_at,
          email: profile.email ?? null,
          phone: profile.phone ?? null,
          tenant_id: u.tenant_id ?? null,
          active_wallet_id: walletStore.active_id ?? null,
          account_frozen: state.account_frozen,
          freeze_reason: state.freeze_reason,
          freeze_notes: state.freeze_notes,
          freeze_order_ref: state.freeze_order_ref,
          freeze_resolution_note: state.freeze_resolution_note,
          freeze_updated_at: state.freeze_updated_at
        };
      });

      return res.json({ ok: true, items });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg || "user_list_failed" });
    }
  });

  r.post("/users/admin/delete", (req, res) => {
    if (!requireAdminToken(req, res)) return;

    const body = getBody(req);
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const confirmUserId = typeof body.confirm_user_id === "string" ? body.confirm_user_id.trim() : "";
    const confirmText = typeof body.confirm_text === "string" ? body.confirm_text.trim() : "";

    if (!userId) return res.status(400).json({ ok: false, reason: "missing_user_id" });
    if (confirmUserId !== userId) return res.status(400).json({ ok: false, reason: "delete_confirmation_mismatch" });
    if (confirmText !== "DELETE USER") return res.status(400).json({ ok: false, reason: "delete_confirmation_required" });

    const u = getUser(repoRoot, userId);
    if (!u) return res.status(404).json({ ok: false, reason: "user_not_found" });

    try {
      deleteUser(repoRoot, userId);
      return res.json({ ok: true, user_id: userId });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg || "user_delete_failed" });
    }
  });

  r.post("/users/admin/set-tenant", (req, res) => {
    if (!requireAdminToken(req, res)) return;

    const body = getBody(req);
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const tenantId =
      body.tenant_id === null
        ? null
        : (typeof body.tenant_id === "string" ? body.tenant_id : "");

    if (!userId) return res.status(400).json({ ok: false, reason: "missing_user_id" });

    const u = getUser(repoRoot, userId);
    if (!u) return res.status(404).json({ ok: false, reason: "user_not_found" });

    try {
      const next = setUserTenantId(repoRoot, userId, tenantId === "" ? null : tenantId);
      return res.json({
        ok: true,
        user_id: next.id,
        tenant_id: next.tenant_id ?? null
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg || "user_set_tenant_failed" });
    }
  });

  r.post("/users/admin/reassign-tenant", (req, res) => {
    if (!requireAdminToken(req, res)) return;

    const body = getBody(req);
    const oldTenantId = typeof body.old_tenant_id === "string" ? body.old_tenant_id.trim() : "";
    const newTenantId = typeof body.new_tenant_id === "string" ? body.new_tenant_id.trim() : "";

    if (!oldTenantId) return res.status(400).json({ ok: false, reason: "missing_old_tenant_id" });
    if (!newTenantId) return res.status(400).json({ ok: false, reason: "missing_new_tenant_id" });

    try {
      const changedCount = reassignUsersTenantId(repoRoot, oldTenantId, newTenantId);
      return res.json({
        ok: true,
        changed_count: changedCount
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg || "user_reassign_tenant_failed" });
    }
  });

  r.post("/users/admin/freeze", (req, res) => {
    if (!requireAdminToken(req, res)) return;

    const body = getBody(req);
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    const orderRef = typeof body.order_ref === "string" ? body.order_ref.trim() : "";

    if (!userId) return res.status(400).json({ ok: false, reason: "missing_user_id" });
    if (!reason) return res.status(400).json({ ok: false, reason: "missing_reason" });

    const u = getUser(repoRoot, userId);
    if (!u) return res.status(404).json({ ok: false, reason: "user_not_found" });

    try {
      const current = readUserState(repoRoot, userId);
      const next = {
        ...current,
        account_frozen: true,
        freeze_reason: reason,
        freeze_notes: notes || null,
        freeze_order_ref: orderRef || null,
        freeze_resolution_note: null,
        freeze_updated_at: new Date().toISOString()
      };

      writeUserState(repoRoot, userId, next);
      return res.json({ ok: true, user_id: userId, state: next });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg || "user_freeze_failed" });
    }
  });

  r.post("/users/admin/unfreeze", (req, res) => {
    if (!requireAdminToken(req, res)) return;

    const body = getBody(req);
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const resolutionNote = typeof body.resolution_note === "string" ? body.resolution_note.trim() : "";

    if (!userId) return res.status(400).json({ ok: false, reason: "missing_user_id" });

    const u = getUser(repoRoot, userId);
    if (!u) return res.status(404).json({ ok: false, reason: "user_not_found" });

    try {
      const current = readUserState(repoRoot, userId);
      const next = {
        ...current,
        account_frozen: false,
        freeze_resolution_note: resolutionNote || null,
        freeze_updated_at: new Date().toISOString()
      };

      writeUserState(repoRoot, userId, next);
      return res.json({ ok: true, user_id: userId, state: next });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, reason: msg || "user_unfreeze_failed" });
    }
  });

  return r;
}
