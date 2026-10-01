// What is installed (Node.js, Claude Code, Codex, Binance's `baw`) and running other programs.

import { spawn } from "node:child_process";

const MAX_OUTPUT = 4 * 1024 * 1024;

// Children run in their own process group (so a timeout can stop all of it); they are
// stopped too when this process ends or is interrupted.
const running = new Set();
let cleanupInstalled = false;

function stopGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", () => running.forEach(stopGroup));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      running.forEach(stopGroup);
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Runs a program and returns its stdout, or null when it is missing, fails or times out.
 * `stderr: true` adds stderr to the text. On a timeout the program's whole process group is
 * stopped, so tools that start their own children (npx, npm) leave nothing behind.
 */
export function run(program, args, { cwd, timeoutMs = 15_000, env, stderr = false } = {}) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(program, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["ignore", "pipe", stderr ? "pipe" : "ignore"],
        detached: true,
      });
    } catch {
      done(null);
      return;
    }
    installCleanup();
    if (child.pid) running.add(child.pid);
    const keep = (chunk) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    };
    child.stdout.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      stopGroup(child.pid);
      done(null);
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      running.delete(child.pid);
      done(result);
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
  });
}

export const versionIn = (text) => /(\d+\.\d+\.\d+)/.exec(text ?? "")?.[1] ?? null;

/** a >= b, for dotted versions. */
export function atLeast(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Codex runs hooks from 0.140; Claude Code has had them far longer. */
export const MIN_CODEX = "0.140.0";
/** The hooks run on whatever `node` is on PATH when the app starts them. */
export const MIN_HOOK_NODE = "18.0.0";

export async function installed() {
  const [claude, codex, baw, node] = await Promise.all([
    run("claude", ["--version"]),
    run("codex", ["--version"]),
    run("baw", ["--version"]),
    run("node", ["--version"]),
  ]);
  return {
    node: process.versions.node,
    pathNode: versionIn(node),
    claude: versionIn(claude),
    codex: versionIn(codex),
    baw: versionIn(baw),
  };
}

/** Opens an http(s) link in the browser, quietly; false when it could not. */
export async function openLink(url) {
  if (!/^https?:\/\//.test(url)) return false;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return (await run(opener, [url], { timeoutMs: 5_000 })) !== null;
}
