import express from "express";
import crypto from "node:crypto";

export type SessionConfig = {
  cookieName: string;
  secret: string;
  secure: boolean;
};

export function sessionConfigFromEnv(): SessionConfig {
  const cookieName = process.env.TD_COOKIE_NAME ?? "td_uid";
  const secret = String(process.env.TD_SESSION_SECRET || "").trim();
  if (!secret || secret.length < 16) {
    throw new Error("TD_SESSION_SECRET must be set (min 16 chars) for multi-user sessions");
  }
  const secure =
    process.env.TD_COOKIE_SECURE === "1" ||
    process.env.TD_COOKIE_SECURE === "true" ||
    process.env.TD_COOKIE_SECURE === "yes";
  return { cookieName, secret, secure };
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signUserId(userId: string, secret: string): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(userId, "utf8");
  return base64url(h.digest());
}

function cookieGet(req: express.Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (typeof raw !== "string" || !raw) return null;

  const parts = raw.split(";");
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(eq + 1).trim());
  }
  return null;
}

function cookieSet(res: express.Response, name: string, value: string, opts: { secure: boolean }): void {
  const parts: string[] = [];
  parts.push(`${name}=${encodeURIComponent(value)}`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (opts.secure) parts.push("Secure");

  const headerValue = parts.join("; ");
  res.setHeader("Set-Cookie", headerValue);
}

export function readSessionUserId(req: express.Request, cfg: SessionConfig): string | null {
  const v = cookieGet(req, cfg.cookieName);
  if (!v) return null;

  const dot = v.lastIndexOf(".");
  if (dot < 1) return null;

  const userId = v.slice(0, dot);
  const sig = v.slice(dot + 1);

  const expect = signUserId(userId, cfg.secret);
  if (sig !== expect) return null;

  return userId;
}

export function setSessionUserId(res: express.Response, userId: string, cfg: SessionConfig): void {
  const sig = signUserId(userId, cfg.secret);
  const value = `${userId}.${sig}`;
  cookieSet(res, cfg.cookieName, value, { secure: cfg.secure });
}

export function clearSessionUserId(res: express.Response, cfg: SessionConfig): void {
  cookieClear(res, cfg.cookieName, { secure: cfg.secure });
}

export function requireUser(cfg: SessionConfig): express.RequestHandler {
  return (req, res, next) => {
    const userId = readSessionUserId(req, cfg);
    if (!userId) {
      return res.status(401).json({ ok: false, reason: "auth_required", login: "/login.html" });
    }
    (res.locals as any).td_user_id = userId;
    return next();
  };
}

function cookieClear(res: express.Response, name: string, opts: { secure: boolean }): void {
  const parts: string[] = [];
  parts.push(`${name}=`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  parts.push("Max-Age=0");
  if (opts.secure) parts.push("Secure");

  const headerValue = parts.join("; ");
  res.setHeader("Set-Cookie", headerValue);
}
