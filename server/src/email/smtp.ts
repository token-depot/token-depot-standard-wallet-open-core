import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";

type SmtpEnv = {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  from: string;
  adminTo: string;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || !v.trim()) throw new Error("smtp_not_configured");
  return v.trim();
}

function parsePort(s: string): number {
  const n = Number(String(s || "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > 65535) throw new Error("smtp_not_configured");
  return Math.floor(n);
}

function parseBool(s: string): boolean {
  const v = String(s || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function hasCRLF(s: string): boolean {
  return /[\r\n]/.test(String(s || ""));
}

function assertSingleEmail(addr: string): string {
  const a = String(addr || "").trim();
  if (!a) throw new Error("email_invalid");
  if (hasCRLF(a)) throw new Error("email_invalid");

  // strict-enough, intentionally not fully RFC5322 (security > edge-case validity)
  const re = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
  if (!re.test(a)) throw new Error("email_invalid");

  // No comma/semicolon lists. Prevent open-relay style abuse.
  if (/[,\s;]/.test(a)) throw new Error("email_invalid");

  return a;
}

function readSmtpEnv(): SmtpEnv {
  const host = mustEnv("TD_SMTP_HOST");
  const port = parsePort(mustEnv("TD_SMTP_PORT"));
  const user = mustEnv("TD_SMTP_USER");
  const pass = mustEnv("TD_SMTP_PASS");
  const secure = parseBool(mustEnv("TD_SMTP_SECURE"));

  // From must be a single plain email address (no display name) for predictability.
  const from = assertSingleEmail(mustEnv("TD_SMTP_FROM"));
  const adminTo = assertSingleEmail(mustEnv("TD_SIGNUP_NOTIFY_TO"));

  return { host, port, user, pass, secure, from, adminTo };
}

type SocketLike = net.Socket | tls.TLSSocket;

function b64(s: string): string {
  return Buffer.from(String(s || ""), "utf8").toString("base64");
}

function withTimeout<T>(p: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(reason)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLineReader(sock: SocketLike) {
  let buf = "";
  const q: string[] = [];
  let closedErr: Error | null = null;
  const waiters: Array<(line: string) => void> = [];
  const errWaiters: Array<(err: Error) => void> = [];

  function flush() {
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx < 0) break;
      const raw = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      const line = raw.replace(/\r?\n$/, "");
      q.push(line);
    }
    while (q.length > 0 && waiters.length > 0) {
      const w = waiters.shift()!;
      w(q.shift()!);
    }
  }

  sock.on("data", (c) => {
    buf += Buffer.isBuffer(c) ? c.toString("utf8") : String(c);
    flush();
  });

  sock.on("error", (e) => {
    closedErr = e instanceof Error ? e : new Error(String(e));
    while (errWaiters.length > 0) errWaiters.shift()!(closedErr);
  });

  sock.on("close", () => {
    if (!closedErr) closedErr = new Error("smtp_socket_closed");
    while (errWaiters.length > 0) errWaiters.shift()!(closedErr);
  });

  return {
    async readLine(): Promise<string> {
      if (q.length > 0) return q.shift()!;
      if (closedErr) throw closedErr;
      return await new Promise<string>((resolve, reject) => {
        waiters.push(resolve);
        errWaiters.push(reject);
      });
    }
  };
}

type SmtpResp = { code: number; lines: string[] };

async function readResp(lr: { readLine(): Promise<string> }): Promise<SmtpResp> {
  const lines: string[] = [];
  let code = 0;

  while (true) {
    const line = await lr.readLine();
    lines.push(line);

    const c = Number(line.slice(0, 3));
    if (!Number.isFinite(c)) continue;
    code = c;

    const cont = line.length >= 4 && line[3] === "-";
    if (!cont) break;
  }

  return { code, lines };
}

function expectCode(resp: SmtpResp, want: number, err: string): void {
  if (resp.code !== want) throw new Error(err);
}

function smtpRespText(resp: SmtpResp): string {
  return resp.lines.join(" | ").slice(0, 1000);
}

function logSmtpFailure(phase: string, reason: string, detail?: string): void {
  const p = String(phase || "smtp").replace(/[^A-Za-z0-9_.:-]/g, "_");
  const r = String(reason || "smtp_failed").replace(/[^A-Za-z0-9_.:-]/g, "_");
  const d = detail ? ` detail=${detail}` : "";
  console.error(`[smtp_send_failed] phase=${p} reason=${r}${d}`);
}

function sendLine(sock: SocketLike, line: string): void {
  if (hasCRLF(line)) throw new Error("smtp_header_injection_blocked");
  sock.write(line + "\r\n");
}

function dotStuff(text: string): string {
  const raw = String(text || "");
  const norm = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = norm.split("\n").map((l) => (l.startsWith(".") ? "." + l : l));
  return lines.join("\r\n");
}

function buildMessage(from: string, to: string, subject: string, text: string): string {
  const f = assertSingleEmail(from);
  const t = assertSingleEmail(to);
  const s = String(subject || "").trim();
  if (!s) throw new Error("smtp_invalid_subject");
  if (hasCRLF(s)) throw new Error("smtp_header_injection_blocked");

  const body = dotStuff(text);

  return [
    `From: ${f}`,
    `To: ${t}`,
    `Subject: ${s}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    body
  ].join("\r\n");
}

async function connectSmtp(env: SmtpEnv): Promise<SocketLike> {
  if (env.secure) {
    const s = tls.connect({ host: env.host, port: env.port, servername: env.host });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        s.once("secureConnect", () => resolve());
        s.once("error", (e) => reject(e));
      }),
      12000,
      "smtp_connect_timeout"
    );
    return s;
  }

  const s = net.connect({ host: env.host, port: env.port });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      s.once("connect", () => resolve());
      s.once("error", (e) => reject(e));
    }),
    12000,
    "smtp_connect_timeout"
  );
  return s;
}

async function upgradeStartTls(env: SmtpEnv, plain: net.Socket): Promise<tls.TLSSocket> {
  const t = tls.connect({ socket: plain, servername: env.host });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      t.once("secureConnect", () => resolve());
      t.once("error", (e) => reject(e));
    }),
    12000,
    "smtp_starttls_timeout"
  );
  return t;
}

async function smtpSendOne(env: SmtpEnv, to: string, subject: string, text: string, phase = "smtp"): Promise<void> {
  const socket = await connectSmtp(env);
  socket.setTimeout(15000);

  try {
    const lr = createLineReader(socket);
    const greet = await withTimeout(readResp(lr), 15000, "smtp_greet_timeout");
    if (greet.code !== 220) throw new Error("smtp_greet_failed");

    sendLine(socket, "EHLO token-depot.local");
    const ehlo1 = await withTimeout(readResp(lr), 15000, "smtp_ehlo_timeout");
    if (ehlo1.code !== 250) throw new Error("smtp_ehlo_failed");

    let tlsSock: SocketLike = socket;

    if (!env.secure) {
      const caps = ehlo1.lines.map((l) => l.toUpperCase());
      const hasStartTls = caps.some((l) => l.includes("STARTTLS"));
      if (!hasStartTls) throw new Error("smtp_starttls_required");

      sendLine(socket, "STARTTLS");
      const st = await withTimeout(readResp(lr), 15000, "smtp_starttls_resp_timeout");
      expectCode(st, 220, "smtp_starttls_failed");

      const upgraded = await upgradeStartTls(env, socket as net.Socket);
      tlsSock = upgraded;

      const lr2 = createLineReader(upgraded);
      sendLine(upgraded, "EHLO token-depot.local");
      const ehlo2 = await withTimeout(readResp(lr2), 15000, "smtp_ehlo2_timeout");
      if (ehlo2.code !== 250) throw new Error("smtp_ehlo_failed");

      // swap reader reference after STARTTLS
      (lr as any).readLine = lr2.readLine;
    }

    sendLine(tlsSock, "AUTH LOGIN");
    const a1 = await withTimeout(readResp(lr), 15000, "smtp_auth_timeout");
    expectCode(a1, 334, "smtp_auth_failed");

    sendLine(tlsSock, b64(env.user));
    const a2 = await withTimeout(readResp(lr), 15000, "smtp_auth_user_timeout");
    expectCode(a2, 334, "smtp_auth_failed");

    sendLine(tlsSock, b64(env.pass));
    const a3 = await withTimeout(readResp(lr), 15000, "smtp_auth_pass_timeout");
    expectCode(a3, 235, "smtp_auth_failed");

    const from = env.from;
    const rcpt = assertSingleEmail(to);

    sendLine(tlsSock, `MAIL FROM:<${assertSingleEmail(from)}>`); // single, no params
    const m1 = await withTimeout(readResp(lr), 15000, "smtp_mailfrom_timeout");
    if (m1.code !== 250) {
      logSmtpFailure(phase, "smtp_mailfrom_failed", smtpRespText(m1));
      throw new Error("smtp_mailfrom_failed");
    }

    sendLine(tlsSock, `RCPT TO:<${rcpt}>`);
    const r1 = await withTimeout(readResp(lr), 15000, "smtp_rcpt_timeout");
    if (r1.code !== 250 && r1.code !== 251) {
      logSmtpFailure(phase, "smtp_rcpt_failed", smtpRespText(r1));
      throw new Error("smtp_rcpt_failed");
    }

    sendLine(tlsSock, "DATA");
    const d1 = await withTimeout(readResp(lr), 15000, "smtp_data_timeout");
    expectCode(d1, 354, "smtp_data_failed");

    const msg = buildMessage(from, rcpt, subject, text);
    tlsSock.write(msg + "\r\n.\r\n");

    const d2 = await withTimeout(readResp(lr), 20000, "smtp_data2_timeout");
    if (d2.code !== 250) {
      logSmtpFailure(phase, "smtp_send_failed", smtpRespText(d2));
      throw new Error("smtp_send_failed");
    }

    sendLine(tlsSock, "QUIT");
    await withTimeout(readResp(lr), 15000, "smtp_quit_timeout");
  } finally {
    socket.destroy();
  }
}

export type SignupEmailInput = {
  userId: string;
  name: string;
  email: string;
  phone: string;
  wantsLicense: boolean;
  tenantSignupNotifyEmail?: string | null;
  ip?: string | null;
};

export type NotificationEmailInput = {
  to: string;
  subject: string;
  text: string;
};

export async function sendSignupEmails(input: SignupEmailInput): Promise<void> {
  const env = readSmtpEnv();

  // Spam-proofing: permitted signup recipients are only the configured Token Depot admin,
  // the resolved tenant signup notification email, and the user's own email.
  const adminTo = env.adminTo;
  const tenantTo = input.tenantSignupNotifyEmail
    ? assertSingleEmail(input.tenantSignupNotifyEmail)
    : null;
  const userTo = assertSingleEmail(input.email);

  const name = String(input.name || "").trim();
  const phone = String(input.phone || "").trim();
  const userId = String(input.userId || "").trim();
  const wants = input.wantsLicense ? "yes" : "no";
  const ip = input.ip ? String(input.ip) : "";

  const adminSubject = `Token Depot — Request Access (${userTo})`;
  const adminBody = [
    "Token Depot — New Request Access",
    "",
    `UTC: ${new Date().toISOString()}`,
    `Name: ${name || "(missing)"}`,
    `Email: ${userTo}`,
    `Phone: ${phone || "(missing)"}`,
    `Wants license token: ${wants}`,
    `User ID: ${userId || "(missing)"}`,
    ip ? `IP: ${ip}` : ""
  ]
    .filter((l) => l !== "")
    .join("\n");

  const tenantSubject = `Tenant Signup Notification (${userTo})`;
  const tenantBody = [
    "Tenant Signup Notification",
    "",
    `UTC: ${new Date().toISOString()}`,
    `Name: ${name || "(missing)"}`,
    `Email: ${userTo}`,
    `Phone: ${phone || "(missing)"}`,
    `Wants license token: ${wants}`,
    `User ID: ${userId || "(missing)"}`,
    ip ? `IP: ${ip}` : ""
  ]
    .filter((l) => l !== "")
    .join("\n");

  const userSubject = "Token Depot — Access request received";
  const userBody = [
    "We received your access request and created your account.",
    "",
    "You may now log in using the email and password you submitted.",
    "",
    "If you did not request this, you can ignore this email.",
    "",
    "— Token Depot"
  ].join("\n");

  await smtpSendOne(env, adminTo, adminSubject, adminBody, "signup_admin");
  await sleep(1500);

  if (tenantTo) {
    await smtpSendOne(env, tenantTo, tenantSubject, tenantBody, "signup_tenant");
    await sleep(1500);
  }

  await smtpSendOne(env, userTo, userSubject, userBody, "signup_user");
}

export async function sendNotificationEmail(input: NotificationEmailInput): Promise<void> {
  const env = readSmtpEnv();
  const to = assertSingleEmail(input.to);
  const subject = String(input.subject || "").trim();
  const text = String(input.text || "").trim();

  if (!subject) throw new Error("smtp_invalid_subject");
  if (!text) throw new Error("smtp_invalid_body");

  await smtpSendOne(env, to, subject, text);
}

type SignupVerificationEmailInput = {
  email: string;
  code: string;
  minutesValid: number;
  name?: string | null;
  ip?: string | null;
};

type Login2faEmailInput = {
  email: string;
  code: string;
  minutesValid: number;
  ip?: string | null;
};

type ProfileEmailChangeVerificationEmailInput = {
  email: string;
  code: string;
  minutesValid: number;
  ip?: string | null;
};

function normalizeAuthCodeEmailInput(email: string, code: string, minutesValid: number): { userTo: string; code: string; mins: number } {
  const userTo = assertSingleEmail(email);

  const c = String(code || "").trim();
  if (!/^[0-9]{8}$/.test(c)) throw new Error("email_auth_code_invalid");

  const minutes = Number(minutesValid);
  const mins = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 10;

  return { userTo, code: c, mins };
}

export async function sendSignupVerificationEmail(input: SignupVerificationEmailInput): Promise<void> {
  const env = readSmtpEnv();
  const { userTo, code, mins } = normalizeAuthCodeEmailInput(input.email, input.code, input.minutesValid);

  const name = input.name ? String(input.name).trim() : "";
  const ip = input.ip ? String(input.ip) : "";

  const subject = "Token Depot — Verify your email";
  const body = [
    "Token Depot — Verify your email",
    "",
    name ? `Name: ${name}` : "",
    `Verification code: ${code}`,
    `Expires in: ${mins} minutes`,
    "",
    "If you did not request this account, you can ignore this email.",
    "",
    `UTC: ${new Date().toISOString()}`,
    ip ? `IP: ${ip}` : ""
  ]
    .filter((l) => l !== "")
    .join("\n");

  await smtpSendOne(env, userTo, subject, body, "signup_verify");
}

export async function sendLogin2faEmail(input: Login2faEmailInput): Promise<void> {
  const env = readSmtpEnv();
  const { userTo, code, mins } = normalizeAuthCodeEmailInput(input.email, input.code, input.minutesValid);

  const ip = input.ip ? String(input.ip) : "";

  const subject = "Token Depot — Login verification code";
  const body = [
    "Token Depot — Login verification",
    "",
    `Login code: ${code}`,
    `Expires in: ${mins} minutes`,
    "",
    "If you did not try to log in, you can ignore this email.",
    "",
    `UTC: ${new Date().toISOString()}`,
    ip ? `IP: ${ip}` : ""
  ]
    .filter((l) => l !== "")
    .join("\n");

  await smtpSendOne(env, userTo, subject, body, "login_2fa");
}

export async function sendProfileEmailChangeVerificationEmail(input: ProfileEmailChangeVerificationEmailInput): Promise<void> {
  const env = readSmtpEnv();
  const { userTo, code, mins } = normalizeAuthCodeEmailInput(input.email, input.code, input.minutesValid);

  const ip = input.ip ? String(input.ip) : "";

  const subject = "Token Depot — Verify your new email";
  const body = [
    "Token Depot — Verify your new email",
    "",
    `Verification code: ${code}`,
    `Expires in: ${mins} minutes`,
    "",
    "If you did not request this email change, you can ignore this email.",
    "",
    `UTC: ${new Date().toISOString()}`,
    ip ? `IP: ${ip}` : ""
  ]
    .filter((l) => l !== "")
    .join("\n");

  await smtpSendOne(env, userTo, subject, body, "profile_email_verify");
}

type PasswordResetEmailInput = {
  email: string;
  code: string;
  minutesValid: number;
  ip?: string | null;
};

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  const env = readSmtpEnv();
  const userTo = assertSingleEmail(input.email);

  const code = String(input.code || "").trim();
  if (!/^[0-9]{8}$/.test(code)) throw new Error("reset_code_invalid");

  const minutes = Number(input.minutesValid);
  const mins = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 10;
  const ip = input.ip ? String(input.ip) : "";

  const subject = "Token Depot — Password reset code";
  const body = [
    "Token Depot — Password reset",
    "",
    `Authorization code: ${code}`,
    `Expires in: ${mins} minutes`,
    "",
    "If you did not request this, you can ignore this email.",
    "",
    `UTC: ${new Date().toISOString()}`,
    ip ? `IP: ${ip}` : ""
  ]
    .filter((l) => l !== "")
    .join("\n");

  await smtpSendOne(env, userTo, subject, body);
}
