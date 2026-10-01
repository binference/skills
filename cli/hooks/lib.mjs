// Shared by the folder's hooks: where the folder is, its key and config, calls to
// binference.io, a lock for the local state, a local outbox for reports that are sent in
// the background, and `baw`. Node.js 18 or newer, no packages: the hooks are copied into
// each agent folder and run from there. The key is read from .binference/key and is never
// printed, logged or sent anywhere but binference.io.

import { spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent folder: hooks live in <folder>/.binference/hooks/. */
export const FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOT = join(FOLDER, ".binference");
const HOOKS = join(DOT, "hooks");
const STATE_FILE = join(DOT, "state.json");
const OUTBOX_FILE = join(DOT, "outbox.jsonl");
const LOG_FILE = join(DOT, "hooks.log");
const MAX_LOG_BYTES = 256 * 1024;

let cachedConfig;
export function config() {
  if (cachedConfig === undefined) {
    try {
      cachedConfig = JSON.parse(readFileSync(join(DOT, "config.json"), "utf8"));
    } catch {
      cachedConfig = null;
    }
  }
  return cachedConfig;
}

let cachedKey;
export function key() {
  if (cachedKey === undefined) {
    let value = null;
    try {
      value = readFileSync(join(DOT, "key"), "utf8").trim();
    } catch {
      // Fall through to the environment.
    }
    if (!value?.startsWith("binf_")) value = process.env.BINF_API_KEY?.trim() ?? null;
    cachedKey = value?.startsWith("binf_") ? value : null;
  }
  return cachedKey;
}

/** One line in .binference/hooks.log, for `npx binference doctor`. Never a key or a prompt. */
export function log(event, fields = {}) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
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

let answered = false;

/**
 * Prints the hook's answer and ends the process once it is written: on macOS and Linux a
 * write to a pipe is asynchronous, and exiting before it drains would cut the answer off.
 * Never resolves, so `await answer(...)` is the hook's last step.
 */
export function answer(output) {
  if (!answered) {
    answered = true;
    const text = output === undefined ? "" : JSON.stringify(output);
    if (!text) process.exit(0);
    process.stdout.on("error", () => process.exit(0));
    process.stdout.write(text, () => process.exit(0));
  }
  return new Promise(() => {});
}

/**
 * Answers with `fallback()` if the hook is still working after `ms`, so a hook always ends
 * before its app's own timeout: an app lets the tool call run when a hook times out.
 */
export function deadline(ms, fallback) {
  setTimeout(() => {
    log("deadline", { ms });
    answer(fallback());
  }, ms);
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
        "user-agent": `binference-hooks/${cfg.version ?? "1"} node/${process.versions.node}`,
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

// One process at a time: hooks for parallel tool calls, sub-agents and other sessions in
// the same folder run at once, and each reads, checks and writes the same files.

const sleep = (ms) => new Promise((resume) => setTimeout(resume, ms));

function lockIsStale(path, staleMs) {
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) return true;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/**
 * Runs `fn` while holding .binference/<name>.lock. Waits up to `waitMs` (0: give up at once)
 * and throws when the lock stays busy. A lock whose process is gone, or older than
 * `staleMs`, is taken over.
 */
export async function withLock(name, fn, { waitMs = 5_000, staleMs = 30_000 } = {}) {
  mkdirSync(DOT, { recursive: true });
  const path = join(DOT, `${name}.lock`);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (lockIsStale(path, staleMs)) {
        try {
          unlinkSync(path);
        } catch {
          // Another process took it over first.
        }
        continue;
      }
      if (Date.now() >= until) throw new Error(`${name}.lock is busy`);
      await sleep(10 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

// The local state: the cockpit as last read, today's dollars, confirmations typed in Codex.

export function readState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function writeStateFile(state) {
  mkdirSync(DOT, { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, STATE_FILE);
}

/** Reads, changes and writes the state under its lock: `change` gets the state and returns the new one. */
export function updateState(change) {
  return withLock("state", () => {
    const next = change(readState());
    if (next) writeStateFile(next);
    return next;
  });
}

/** How long the rules read from the site count as current, and as usable at all. */
export const FRESH_MS = 60_000;
export const STALE_MS = 24 * 60 * 60_000;

/**
 * The cockpit's state: from the site when the copy here is older than `maxAgeMs`, else the
 * copy. With the site unreachable, a copy under a day old still applies. A copy dated in
 * the future was not written by the hooks and is never trusted.
 */
export async function cockpitState(maxAgeMs = FRESH_MS) {
  const local = readState();
  const age = Date.now() - (Number(local.cockpit_at) || 0);
  const usable = Boolean(local.cockpit) && age >= 0;
  if (usable && age < maxAgeMs) return { state: local.cockpit, source: "cache" };
  const fetched = await api("GET", "/api/v1/cockpit");
  if (fetched.ok && fetched.json) {
    await saveCockpit(fetched.json);
    return { state: fetched.json, source: "site" };
  }
  if (usable && age < STALE_MS) return { state: local.cockpit, source: "stale" };
  return { state: null, source: "none", status: fetched.status };
}

export async function saveCockpit(cockpit) {
  try {
    await updateState((local) => ({ ...local, cockpit, cockpit_at: Date.now() }));
  } catch (error) {
    log("state_write_failed", { error: String(error?.message ?? error) });
  }
}

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Dollars this folder's hooks let through today (UTC). Kept until the day turns, not reset
 * when the cockpit is read: a trade's report can reach the site after the next read.
 */
export function tradedTodayHere(local) {
  return local.today?.day === utcDay() ? Number(local.today.usd) || 0 : 0;
}

export function todayEntry(usd) {
  return { day: utcDay(), usd };
}

// Reports: queued in a local outbox and sent by a background process, so no hook waits on
// binference.io before it answers.

const MAX_OUTBOX_LINES = 500;

function readOutbox() {
  let text = "";
  try {
    text = readFileSync(OUTBOX_FILE, "utf8");
  } catch {
    return [];
  }
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      // Lines from older hooks hold the event alone.
      lines.push(
        parsed?.id && parsed.event
          ? parsed
          : { id: createHash("sha256").update(raw).digest("hex"), session: null, event: parsed },
      );
    } catch {
      // A torn line is dropped.
    }
  }
  return lines;
}

function writeOutbox(lines) {
  mkdirSync(DOT, { recursive: true });
  const kept = lines.slice(-MAX_OUTBOX_LINES);
  const temp = `${OUTBOX_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, kept.map((line) => JSON.stringify(line)).join("\n") + (kept.length ? "\n" : ""));
  renameSync(temp, OUTBOX_FILE);
}

/** Adds actions to the outbox. Nothing is sent here: `flushInBackground()` sends them. */
export async function queueReports(events, sessionId = null) {
  if (config()?.report === false || events.length === 0) return;
  const lines = events.map((event) => ({ id: randomUUID(), session: sessionId, event }));
  try {
    await withLock("outbox", () => writeOutbox([...readOutbox(), ...lines]));
  } catch (error) {
    log("outbox_write_failed", { error: String(error?.message ?? error) });
  }
}

/** Starts a detached process that sends the outbox; it leaves at once when one already runs. */
export function flushInBackground() {
  try {
    const child = spawn(process.execPath, [join(HOOKS, "flush.mjs")], {
      detached: true,
      stdio: "ignore",
      cwd: FOLDER,
    });
    child.on("error", () => {});
    child.unref();
  } catch (error) {
    log("flush_spawn_failed", { error: String(error?.message ?? error) });
  }
}

/**
 * Sends what the outbox holds, one sender at a time, in batches per session. Stops at the
 * first sign the site is down or busy, and keeps what did not go through.
 */
export async function flushOutbox() {
  if (config()?.report === false) return;
  await withLock(
    "flush",
    async () => {
      const queued = await withLock("outbox", readOutbox);
      if (queued.length === 0) return;
      const sessions = new Map();
      for (const line of queued) {
        const list = sessions.get(line.session ?? "") ?? [];
        list.push(line);
        sessions.set(line.session ?? "", list);
      }
      const done = new Set();
      send: for (const [session, lines] of sessions) {
        for (let i = 0; i < lines.length; i += 50) {
          const batch = lines.slice(i, i + 50);
          const sent = await api("POST", "/api/v1/cockpit/events", {
            ...(session ? { app_session_id: session } : {}),
            events: batch.map((line) => line.event),
          });
          if (!sent.ok && (sent.status === 0 || sent.status === 429 || sent.status >= 500)) break send;
          // A 4xx other than 429 will never go through: dropping it keeps the outbox moving.
          if (!sent.ok) log("report_dropped", { status: sent.status, count: batch.length });
          for (const line of batch) done.add(line.id);
        }
      }
      if (done.size > 0) {
        await withLock("outbox", () => writeOutbox(readOutbox().filter((line) => !done.has(line.id))));
      }
    },
    { waitMs: 0, staleMs: 5 * 60_000 },
  );
}

export function outboxSize() {
  return readOutbox().length;
}

/** A stable id for an action: the app's own tool call id, or one made from the command. */
export function actionRef(hookInput, extra = "") {
  const id = hookInput?.tool_use_id;
  if (typeof id === "string" && /^[\w-]{8,64}$/.test(id)) return extra ? `${id}-${extra}` : id;
  const seed = `${hookInput?.session_id ?? ""}|${JSON.stringify(hookInput?.tool_input ?? {})}|${extra}`;
  return `h-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

/** A four-digit confirmation code, every value equally likely. */
export const newCode = () => String(randomInt(1000, 10_000));

// Programs: Binance's Agentic Wallet CLI.

const MAX_OUTPUT = 1024 * 1024;

/** Runs a program and returns `{ code, out }` with its stdout, or null when it is missing, fails to start or times out. */
export function capture(program, args, { timeoutMs = 5_000 } = {}) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(program, args, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      done(null);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", (code, signal) => done(signal ? null : { code, out }));
  });
}

/** Runs `baw <args> --json` and returns its JSON `data`, or null on any failure or timeout. */
export async function baw(args, timeoutMs = 5_000) {
  const result = await capture("baw", [...args, "--json"], { timeoutMs });
  const parsed = result ? parseJsonOutput(result.out) : null;
  return parsed?.success === true ? (parsed.data ?? null) : null;
}

/** Whether `baw` is installed, and its version. */
export async function bawVersion(timeoutMs = 4_000) {
  const result = await capture("baw", ["--version"], { timeoutMs });
  const version = /(\d+\.\d+\.\d+)/.exec(result?.out ?? "")?.[1];
  return result?.code === 0 && version ? version : null;
}

const MAX_SCAN = 64 * 1024;
const MAX_TRIES = 200;

/**
 * The last JSON object a command printed, when its output is or ends with one. Looks only at
 * the end of the output and tries a bounded number of starting points.
 */
export function parseJsonOutput(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Look for the last top-level object.
  }
  const tail = trimmed.length > MAX_SCAN ? trimmed.slice(-MAX_SCAN) : trimmed;
  const end = tail.lastIndexOf("}");
  if (end < 0) return null;
  let start = tail.lastIndexOf("{", end);
  for (let tries = 0; start >= 0 && tries < MAX_TRIES; tries += 1) {
    try {
      return JSON.parse(tail.slice(start, end + 1));
    } catch {
      // Keep widening.
    }
    // lastIndexOf with a negative position searches from 0 again: stop at the start.
    if (start === 0) break;
    start = tail.lastIndexOf("{", start - 1);
  }
  return null;
}

/** Which agent app runs this hook: the folder's own setting first, then what the input shows. */
export function appOf(hookInput) {
  const configured = config()?.app;
  if (configured === "claude_code" || configured === "codex") return configured;
  if (hookInput?.turn_id !== undefined || hookInput?.transcript_path?.includes("/.codex/")) return "codex";
  return "claude_code";
}
