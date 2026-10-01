// Shared by the folder's hooks: where the folder is, its key and config, calls to
// binference.io, a local outbox for reports that could not be sent, and `baw`.
// Node.js 18 or newer, no packages. The key is read from .binference/key and is never
// printed, logged or sent anywhere but binference.io.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent folder: hooks live in <folder>/.binference/hooks/. */
export const FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOT = join(FOLDER, ".binference");
const STATE_FILE = join(DOT, "state.json");
const OUTBOX_FILE = join(DOT, "outbox.jsonl");
const LOG_FILE = join(DOT, "hooks.log");
const MAX_LOG_BYTES = 256 * 1024;

export function config() {
  try {
    return JSON.parse(readFileSync(join(DOT, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

export function key() {
  try {
    const value = readFileSync(join(DOT, "key"), "utf8").trim();
    if (value.startsWith("binf_")) return value;
  } catch {
    // Fall through to the environment.
  }
  const env = process.env.BINF_API_KEY?.trim();
  return env?.startsWith("binf_") ? env : null;
}

/** One line in .binference/hooks.log, for `npx binference doctor`. Never a key or a prompt. */
export function log(event, fields = {}) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(
      LOG_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
    );
  } catch {
    // Logging never breaks a hook.
  }
}

/** The hook's input: the JSON the agent app writes on stdin. */
export async function input() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Prints the hook's answer and ends. */
export function answer(output) {
  if (output !== undefined) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/**
 * A call to binference.io with the folder's key. Never throws: `{ ok, status, json }`,
 * with status 0 when the site could not be reached in time.
 */
export async function api(method, path, body, timeoutMs = 4_000) {
  const cfg = config();
  const binf = key();
  if (!cfg?.api_url || !binf) return { ok: false, status: 0, json: null };
  try {
    const response = await fetch(`${cfg.api_url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${binf}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": `binference-hooks/${cfg.version ?? "1"}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      // No body (204) or not JSON.
    }
    if (!response.ok) log("api_refused", { path, status: response.status, code: json?.error?.code });
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    log("api_unreachable", { path, error: String(error?.name ?? error) });
    return { ok: false, status: 0, json: null };
  }
}

// The local state: the cockpit as last read, and confirmations typed in Codex.

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(state) {
  try {
    mkdirSync(DOT, { recursive: true });
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, STATE_FILE);
  } catch (error) {
    log("state_write_failed", { error: String(error) });
  }
}

/** How long the rules read from the site count as current, and as usable at all. */
export const FRESH_MS = 60_000;
export const STALE_MS = 24 * 60 * 60_000;

/**
 * The cockpit's state: from the site when the copy here is older than `maxAgeMs`, else the
 * copy. With the site unreachable, a copy under a day old still applies.
 */
export async function cockpitState(maxAgeMs = FRESH_MS) {
  const local = readState();
  const age = Date.now() - (local.cockpit_at ?? 0);
  if (local.cockpit && age < maxAgeMs) return { state: local.cockpit, source: "cache" };
  const fetched = await api("GET", "/api/v1/cockpit");
  if (fetched.ok && fetched.json) {
    saveCockpit(fetched.json);
    return { state: fetched.json, source: "site" };
  }
  if (local.cockpit && age < STALE_MS) return { state: local.cockpit, source: "stale" };
  return { state: null, source: "none", status: fetched.status };
}

export function saveCockpit(cockpit) {
  const local = readState();
  writeState({ ...local, cockpit, cockpit_at: Date.now(), today: todayEntry(local) });
}

/** Today's dollars traded here since the site last counted: reset when the UTC day turns. */
function todayEntry(local) {
  const day = new Date().toISOString().slice(0, 10);
  return local.today?.day === day ? { day, usd: 0 } : { day, usd: 0 };
}

export function addTradedToday(usd) {
  const local = readState();
  const day = new Date().toISOString().slice(0, 10);
  const current = local.today?.day === day ? local.today.usd : 0;
  writeState({ ...local, today: { day, usd: current + usd } });
}

export function tradedTodayHere() {
  const local = readState();
  const day = new Date().toISOString().slice(0, 10);
  return local.today?.day === day ? local.today.usd : 0;
}

// Reports: sent at once, kept in an outbox when the site cannot be reached.

const MAX_OUTBOX_LINES = 500;

function readOutbox() {
  try {
    return readFileSync(OUTBOX_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function writeOutbox(events) {
  try {
    const kept = events.slice(-MAX_OUTBOX_LINES);
    const temp = `${OUTBOX_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, kept.map((event) => JSON.stringify(event)).join("\n") + (kept.length ? "\n" : ""));
    renameSync(temp, OUTBOX_FILE);
  } catch (error) {
    log("outbox_write_failed", { error: String(error) });
  }
}

/** Sends actions, with any the outbox still holds; keeps what did not go through. */
export async function report(events, appSessionId = null) {
  const cfg = config();
  if (cfg?.report === false) return;
  const queued = [...readOutbox(), ...events];
  if (queued.length === 0) return;
  const unsent = [];
  for (let i = 0; i < queued.length; i += 50) {
    const batch = queued.slice(i, i + 50);
    const sent = await api("POST", "/api/v1/cockpit/events", {
      ...(appSessionId ? { app_session_id: appSessionId } : {}),
      events: batch,
    });
    // A 4xx other than 429 will never go through: dropping it keeps the outbox moving.
    if (!sent.ok && (sent.status === 0 || sent.status === 429 || sent.status >= 500)) {
      unsent.push(...batch);
    } else if (!sent.ok) {
      log("report_dropped", { status: sent.status, count: batch.length });
    }
  }
  writeOutbox(unsent);
}

export async function flushOutbox(appSessionId = null) {
  if (readOutbox().length > 0) await report([], appSessionId);
}

/** A stable id for an action: the app's own tool call id, or one made from the command. */
export function actionRef(hookInput, extra = "") {
  const id = hookInput?.tool_use_id;
  if (typeof id === "string" && /^[\w-]{8,64}$/.test(id)) return extra ? `${id}-${extra}` : id;
  const seed = `${hookInput?.session_id ?? ""}|${JSON.stringify(hookInput?.tool_input ?? {})}|${extra}`;
  return `h-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

export const newCode = () => String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));

// Binance's Agentic Wallet CLI.

/** Runs `baw <args> --json` and returns its JSON `data`, or null on any failure or timeout. */
export function baw(args, timeoutMs = 5_000) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn("baw", [...args, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseJsonOutput(out);
      done(parsed?.success === true ? (parsed.data ?? null) : null);
    });
  });
}

/** The last JSON object a command printed, when its output is or ends with one. */
export function parseJsonOutput(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Look for the last top-level object.
  }
  const end = trimmed.lastIndexOf("}");
  for (let start = trimmed.lastIndexOf("{", end); start >= 0; start = trimmed.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Keep widening.
    }
  }
  return null;
}

/** Whether `baw` is installed, and its version. */
export async function bawVersion() {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn("baw", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, 4_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
      done(code === 0 && version ? version : null);
    });
  });
}

/** Which agent app runs this hook. */
export function appOf(hookInput) {
  if (process.env.CLAUDE_PROJECT_DIR || hookInput?.transcript_path?.includes("/.claude/")) {
    return "claude_code";
  }
  if (hookInput?.turn_id !== undefined || process.env.CODEX_HOME || hookInput?.transcript_path?.includes("/.codex/")) {
    return "codex";
  }
  return config()?.app ?? "claude_code";
}
