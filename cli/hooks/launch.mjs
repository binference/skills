#!/usr/bin/env node
// Starts the folder's agent app on bInference: `./start` in the folder runs this copy, and
// `npx binference start` runs the same code. Neither app takes its provider or login from a
// folder, so this passes them for this launch alone: the key and address in the
// environment, and Codex's provider on its command line.
//
// The app is this process's child and stays tied to it: a stop signal reaches the app, and
// this process exits the way the app did.

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class LaunchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The folder's config and key, or null for each one missing. */
export function readFolder(folder) {
  let cfg = null;
  let key = null;
  try {
    cfg = JSON.parse(readFileSync(join(folder, ".binference", "config.json"), "utf8"));
  } catch {
    // Not an agent folder.
  }
  try {
    const value = readFileSync(join(folder, ".binference", "key"), "utf8").trim();
    key = value.startsWith("binf_") ? value : null;
  } catch {
    // No key.
  }
  return { cfg, key };
}

/**
 * What one launch of the folder's app needs in its environment: the key for the hooks and
 * the MCP server, and for Claude Code its address, login and model.
 */
export function launchEnv(cfg, key) {
  return cfg.app === "codex"
    ? { BINF_API_KEY: key }
    : {
        BINF_API_KEY: key,
        ANTHROPIC_BASE_URL: `${cfg.api_url}/api`,
        ANTHROPIC_AUTH_TOKEN: key,
        // Left empty so Claude Code never falls back to another key.
        ANTHROPIC_API_KEY: "",
        ...(cfg.model ? { ANTHROPIC_MODEL: cfg.model } : {}),
      };
}

/** The Codex command-line settings that make bInference its provider for one launch. */
export function codexProviderFlags(api) {
  return [
    "-c",
    "model_provider=binference",
    "-c",
    `model_providers.binference={name="bInference",base_url=${JSON.stringify(`${api}/api/v1`)},env_key="BINF_API_KEY",wire_api="responses"}`,
  ];
}

/** Runs the folder's app until it ends, then exits with its code, or by its signal. */
export function launch({ folder: path, args = [] }) {
  const folder = resolve(path ?? ".");
  const { cfg, key } = readFolder(folder);
  if (!cfg) throw new LaunchError("not_agent_folder", `${folder} is not an agent folder. Make one with "npx binference agent-os <name>".`);
  if (!key) throw new LaunchError("no_key", 'This folder has no key. Run "npx binference doctor" in it.');
  const program = cfg.app === "codex" ? "codex" : "claude";
  const programArgs = cfg.app === "codex" ? [...codexProviderFlags(cfg.api_url), ...args] : args;

  return new Promise((_, fail) => {
    const child = spawn(program, programArgs, {
      cwd: folder,
      stdio: "inherit",
      env: { ...process.env, ...launchEnv(cfg, key) },
    });
    // The terminal sends Ctrl-C to the app itself; this process only waits for it to end.
    const ignore = () => {};
    const forward = (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    process.on("SIGINT", ignore);
    process.on("SIGQUIT", ignore);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    child.on("error", (error) =>
      fail(
        new LaunchError(
          "app_missing",
          error.code === "ENOENT" ? `Could not start ${program}: it is not installed or not on PATH.` : `Could not start ${program}: ${error.message}`,
        ),
      ),
    );
    child.on("exit", (code, signal) => {
      for (const name of ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(name);
      // Ending by the same signal tells the shell, or a process manager, how the app ended.
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
  });
}

// Run as a script: the folder is the one this copy lives in, <folder>/.binference/hooks/.
// import.meta.url has symlinks resolved (macOS's /var is /private/var), so argv[1] is too.
const runAsScript = () => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};
if (process.argv[1] && runAsScript()) {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  launch({ folder, args: process.argv.slice(2) }).catch((error) => {
    process.stderr.write(`\n✗ ${error.message}\n\n`);
    process.exitCode = 1;
  });
}
