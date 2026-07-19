#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { createUser, setUserAuth, setUserIdentity } from "../server/src/storage/userStore";

function readArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const repoRoot = process.cwd();

const label = readArg("label");
const email = readArg("email");
const phone = readArg("phone") || "";
const password = readArg("password");

if (!label) die("missing --label");
if (!email) die("missing --email");
if (!password) die("missing --password");

const u = createUser(repoRoot, label);
setUserIdentity(repoRoot, u.id, email, phone);
setUserAuth(repoRoot, u.id, password);

console.log(JSON.stringify({ ok: true, user_id: u.id, label: u.label, email: (email || "").trim().toLowerCase() }, null, 2));