// `npx binference start`: launches the folder's app on bInference. Neither app takes its
// provider or login from a folder, so this passes them for this launch alone: the key and
// address in the environment, and Codex's provider on its command line.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { codexProviderFlags, launchEnv, readConfig, readKey } from "./folder.mjs";
import { fail } from "./ui.mjs";

export function start({ folder: path, args }) {
  const folder = resolve(path ?? ".");
  const cfg = readConfig(folder);
  if (!cfg) fail(`No agent folder here. Make one with "npx binference agent-os <name>".`);
  const key = readKey(folder);
  if (!key) fail('This folder has no key. Run "npx binference doctor".');
  const [program, programArgs] =
    cfg.app === "codex" ? ["codex", [...codexProviderFlags(cfg.api_url), ...args]] : ["claude", args];
  const child = spawn(program, programArgs, {
    cwd: folder,
    stdio: "inherit",
    env: { ...process.env, ...launchEnv(cfg, key) },
    shell: process.platform === "win32",
  });
  child.on("error", () => fail(`Could not start ${program}. Is it installed?`));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
