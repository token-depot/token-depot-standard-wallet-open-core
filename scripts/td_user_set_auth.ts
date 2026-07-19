#!/usr/bin/env node
import process from "node:process";
import { setUserAuth, setUserIdentity } from "../server/src/storage/userStore";

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

const userId = readArg("user_id");
const email = readArg("email");
const phone = readArg("phone") || "";
const password = readArg("password");

if (!userId) die("missing --user_id");
if (!email) die("missing --email");
if (!password) die("missing --password");

setUserIdentity(repoRoot, userId, email, phone);
setUserAuth(repoRoot, userId, password);

console.log(JSON.stringify({ ok: true, user_id: userId, email: (email || "").trim().toLowerCase() }, null, 2));