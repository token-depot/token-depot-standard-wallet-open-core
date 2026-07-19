import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type UserState = {
  active_wallet_id: string | null;
  account_frozen: boolean;
  freeze_reason: string | null;
  freeze_notes: string | null;
  freeze_order_ref: string | null;
  freeze_resolution_note: string | null;
  freeze_updated_at: string | null;
};

function userDir(repoRoot: string, userId: string): string {
  return path.join(repoRoot, "data", "users", userId);
}

function statePath(repoRoot: string, userId: string): string {
  return path.join(userDir(repoRoot, userId), "state.json");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function readUserState(repoRoot: string, userId: string): UserState {
  const p = statePath(repoRoot, userId);
  ensureDir(path.dirname(p));
  if (!fs.existsSync(p)) {
    const initial: UserState = {
      active_wallet_id: null,
      account_frozen: false,
      freeze_reason: null,
      freeze_notes: null,
      freeze_order_ref: null,
      freeze_resolution_note: null,
      freeze_updated_at: null
    };
    atomicWriteJson(p, initial);
    return initial;
  }

  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Partial<UserState>;

  const active_wallet_id =
    typeof parsed.active_wallet_id === "string" || parsed.active_wallet_id === null
      ? parsed.active_wallet_id
      : null;

  const account_frozen = parsed.account_frozen === true;

  const freeze_reason =
    typeof parsed.freeze_reason === "string" || parsed.freeze_reason === null
      ? parsed.freeze_reason
      : null;

  const freeze_notes =
    typeof parsed.freeze_notes === "string" || parsed.freeze_notes === null
      ? parsed.freeze_notes
      : null;

  const freeze_order_ref =
    typeof parsed.freeze_order_ref === "string" || parsed.freeze_order_ref === null
      ? parsed.freeze_order_ref
      : null;

  const freeze_resolution_note =
    typeof parsed.freeze_resolution_note === "string" || parsed.freeze_resolution_note === null
      ? parsed.freeze_resolution_note
      : null;

  const freeze_updated_at =
    typeof parsed.freeze_updated_at === "string" || parsed.freeze_updated_at === null
      ? parsed.freeze_updated_at
      : null;

  return {
    active_wallet_id,
    account_frozen,
    freeze_reason,
    freeze_notes,
    freeze_order_ref,
    freeze_resolution_note,
    freeze_updated_at
  };
}

export function writeUserState(repoRoot: string, userId: string, state: UserState): void {
  const p = statePath(repoRoot, userId);
  atomicWriteJson(p, state);
}
