// What is installed: Node.js, Claude Code, Codex and Binance's `baw`, with versions.

import { spawn } from "node:child_process";

/** Runs a program and returns its output, or null when it is missing or fails. */
export function run(program, args, { cwd, timeoutMs = 15_000, env } = {}) {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(program, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out : null);
    });
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
export const MIN_NODE = "22.0.0";

export async function installed() {
  const [claude, codex, baw] = await Promise.all([
    run("claude", ["--version"]),
    run("codex", ["--version"]),
    run("baw", ["--version"]),
  ]);
  return {
    node: process.versions.node,
    claude: versionIn(claude),
    codex: versionIn(codex),
    baw: versionIn(baw),
  };
}

/** Opens a link in the browser, quietly; false when it could not. */
export async function openLink(url) {
  const opener =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return (await run(opener[0], opener[1], { timeoutMs: 5_000 })) !== null;
}
