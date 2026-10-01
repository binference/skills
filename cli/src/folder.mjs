// Writes an agent folder: the house rules, the app's settings, the hooks, the launcher and
// the key. Everything the agent app needs lives in the folder; nothing global is touched.
// Repairs (`doctor --fix`) merge into what is there and keep the person's own settings.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readFolder } from "../hooks/launch.mjs";
import { usageError } from "./errors.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE_HOOKS = join(PACKAGE, "hooks");
export const CLI_VERSION = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).version;

/** The model each app starts on; any model on binference.io/models works. */
export const DEFAULT_MODEL = {
  claude_code: "anthropic/claude-sonnet-5.5",
  codex: "openai/gpt-6.1-sol",
};

/** A model id as binference.io lists them, such as "anthropic/claude-sonnet-5.5". */
export function checkModel(model) {
  if (model !== undefined && !/^[A-Za-z0-9][\w.:/-]{0,127}$/.test(model)) {
    throw usageError(`"${model}" is not a model id.`, "Use an id from https://binference.io/models, such as anthropic/claude-sonnet-5.5.");
  }
  return model;
}

/** The API's address from BINF_URL: https, or http on this machine only. */
export function apiUrl(raw = process.env.BINF_URL) {
  if (raw === undefined || raw === "") return "https://binference.io";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`BINF_URL is not a URL: ${raw}`, "Unset it to use https://binference.io.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw usageError(`BINF_URL must use https: ${raw}`, "Plain http works only for localhost.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
  if (mode) chmodSync(path, mode);
}

/** The hook files this version of the CLI installs. */
export const hookFiles = () => readdirSync(PACKAGE_HOOKS).filter((file) => file.endsWith(".mjs"));

/** Copies the hooks into <folder>/.binference/hooks, replacing older copies. */
export function installHooks(folder) {
  const target = join(folder, ".binference", "hooks");
  mkdirSync(target, { recursive: true });
  for (const file of hookFiles()) copyFileSync(join(PACKAGE_HOOKS, file), join(target, file));
  return target;
}

/** `./start` in the folder: runs the launcher copied with the hooks, with no npx in between. */
export const LAUNCHER = `#!/bin/sh
# Starts this agent's app on bInference. Made by "npx binference agent-os".
exec node "$(dirname "$0")/.binference/hooks/launch.mjs" "$@"
`;

export function installLauncher(folder) {
  write(join(folder, "start"), LAUNCHER, 0o755);
}

/** Copies the bInference skill into the folder, where both apps read skills. */
export function installOwnSkill(folder) {
  // Packed with the CLI on npm; beside it in the repository.
  const source = [join(PACKAGE, "skills", "binference"), join(PACKAGE, "..", "skills", "binference")].find((path) =>
    existsSync(join(path, "SKILL.md")),
  );
  if (!source) return false;
  for (const root of [join(folder, ".claude", "skills"), join(folder, ".agents", "skills")]) {
    copyTree(source, join(root, "binference"));
  }
  return true;
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

/** The hook files each app runs, by event. */
export const HOOK_EVENTS = {
  claude_code: { SessionStart: "session-start.mjs", PreToolUse: "pre-tool.mjs", PostToolUse: "post-tool.mjs", Stop: "stop.mjs" },
  codex: {
    SessionStart: "session-start.mjs",
    PreToolUse: "pre-tool.mjs",
    PostToolUse: "post-tool.mjs",
    UserPromptSubmit: "prompt.mjs",
    Stop: "stop.mjs",
  },
};
const TIMEOUTS = { SessionStart: 20, PreToolUse: 30, PostToolUse: 15, UserPromptSubmit: 5, Stop: 10 };

function hookEntries(app, folder) {
  const command = (file) =>
    app === "codex"
      ? // Codex runs hook commands in the session's folder: an absolute path always works.
        `node ${JSON.stringify(join(folder, ".binference", "hooks", file))}`
      : `node "$CLAUDE_PROJECT_DIR/.binference/hooks/${file}"`;
  const entries = {};
  for (const [event, file] of Object.entries(HOOK_EVENTS[app])) {
    const hooks = [{ type: "command", command: command(file), timeout: TIMEOUTS[event] }];
    // Claude Code runs the trade hooks only for the shell and Binance's MCP tools. Codex runs
    // them for every tool and the hook itself leaves at once when nothing is a trade.
    const matcher = app === "claude_code" && (event === "PreToolUse" || event === "PostToolUse") ? "Bash|mcp__binance.*" : undefined;
    entries[event] = [{ ...(matcher ? { matcher } : {}), hooks }];
  }
  return entries;
}

const isOurs = (entry) => (entry?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes(".binference/hooks/"));

/** The hooks block with bInference's entries replaced and everyone else's kept. */
function mergeHooks(existing, app, folder) {
  const merged = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const [event, entries] of Object.entries(hookEntries(app, folder))) {
    const others = Array.isArray(merged[event]) ? merged[event].filter((entry) => !isOurs(entry)) : [];
    merged[event] = [...others, ...entries];
  }
  return merged;
}

/** The events whose bInference hook is missing from an app's settings. */
export function missingHooks(folder, app) {
  const settings = readJson(settingsPath(folder, app));
  return Object.entries(HOOK_EVENTS[app])
    .filter(([event, file]) => {
      const entries = settings?.hooks?.[event];
      return !Array.isArray(entries) || !entries.some((entry) => (entry?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes(`.binference/hooks/${file}`)));
    })
    .map(([event]) => event);
}

export const settingsPath = (folder, app) =>
  app === "codex" ? join(folder, ".codex", "hooks.json") : join(folder, ".claude", "settings.json");

/**
 * Built-in tools may never read the key or edit the brakes. The shell is covered by the
 * pre-tool hook, and fully by the sandbox below when it is on.
 */
const PROTECTED = [
  "Read(./.binference/key)",
  "Edit(./.binference/**)",
  "Edit(./.claude/settings.json)",
  "Edit(./.codex/**)",
  "Edit(./.mcp.json)",
  "Edit(./start)",
];

/**
 * Claude Code's sandbox, opt-in with --sandbox: the system itself keeps shell commands from
 * writing the brakes (it protects .claude/ and .mcp.json on its own). New network hosts,
 * such as Binance's, need approving once.
 */
export const SANDBOX = {
  enabled: true,
  allowUnsandboxedCommands: false,
  filesystem: { denyWrite: ["./.binference", "./start"] },
};

/** .claude/settings.json with bInference's parts set and everything else kept. */
export function claudeSettings(existing, { sandbox = false } = {}) {
  const base = existing && typeof existing === "object" ? existing : {};
  const deny = Array.isArray(base.permissions?.deny) ? base.permissions.deny : [];
  const servers = Array.isArray(base.enabledMcpjsonServers) ? base.enabledMcpjsonServers : [];
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    ...base,
    permissions: { ...base.permissions, deny: [...deny, ...PROTECTED.filter((rule) => !deny.includes(rule))] },
    hooks: mergeHooks(base.hooks, "claude_code"),
    enabledMcpjsonServers: servers.includes("binference") ? servers : [...servers, "binference"],
    ...(sandbox
      ? {
          sandbox: {
            ...base.sandbox,
            ...SANDBOX,
            filesystem: {
              ...base.sandbox?.filesystem,
              denyWrite: [...new Set([...(base.sandbox?.filesystem?.denyWrite ?? []), ...SANDBOX.filesystem.denyWrite])],
            },
          },
        }
      : {}),
  };
}

/** .codex/hooks.json: only the `hooks` key (Codex 0.140 to 0.142 refuse any other). */
export function codexHooks(existing, folder) {
  return { hooks: mergeHooks(existing?.hooks, "codex", folder) };
}

/** A TOML string. Model ids and URLs are checked first, so this is plain quoting. */
const toml = (value) => JSON.stringify(String(value));

function codexConfig(api, model) {
  return [
    "# bInference is set as the model provider when ./start (or `npx binference start`)",
    "# launches Codex: Codex takes a provider only from your own config or the command line.",
    `model = ${toml(model)}`,
    // Web search on every call reserves many rounds of searching up front (docs: Codex).
    'web_search = "disabled"',
    "",
    mcpSection(api),
  ].join("\n");
}

const mcpSection = (api) =>
  ["[mcp_servers.binference]", `url = ${toml(`${api}/api/mcp`)}`, 'bearer_token_env_var = "BINF_API_KEY"', ""].join("\n");

const GITIGNORE = [
  "# bInference: the key and local state never leave this machine.",
  ".binference/key",
  ".binference/state.json",
  ".binference/outbox.jsonl",
  ".binference/hooks.log*",
  ".binference/*.lock",
  ".binference/*.tmp",
  ".binference/pending.json",
];

function ensureGitignore(folder) {
  const path = join(folder, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = GITIGNORE.filter((line) => line.startsWith("#") ? !current.includes(line) : !current.split("\n").includes(line));
  if (missing.length > 0) write(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

/** Writes a new agent folder. */
export function writeFolder(folder, { api, app, key, cockpit, model, sandbox = false }) {
  const dot = join(folder, ".binference");
  write(join(dot, "key"), `${key}\n`, 0o600);
  write(
    join(dot, "config.json"),
    json({
      version: CLI_VERSION,
      cockpit_id: cockpit.id,
      name: cockpit.name,
      cockpit_url: cockpit.url,
      app,
      api_url: api,
      model,
      report: true,
      created_at: new Date().toISOString(),
    }),
  );
  installHooks(folder);
  installLauncher(folder);

  if (!existsSync(join(folder, "AGENTS.md"))) copyFileSync(join(PACKAGE, "templates", "AGENTS.md"), join(folder, "AGENTS.md"));
  if (!existsSync(join(folder, "CLAUDE.md"))) write(join(folder, "CLAUDE.md"), "@AGENTS.md\n");
  ensureGitignore(folder);

  if (app === "claude_code") {
    // Claude Code takes its login only from its own config or the environment, never from
    // a folder: the launcher passes the key and the address (launchEnv in hooks/launch.mjs).
    write(settingsPath(folder, app), json(claudeSettings(readJson(settingsPath(folder, app)), { sandbox })));
    write(
      join(folder, ".mcp.json"),
      json({
        mcpServers: {
          binference: { type: "http", url: `${api}/api/mcp`, headers: { Authorization: "Bearer ${BINF_API_KEY}" } },
        },
      }),
    );
  } else {
    write(join(folder, ".codex", "config.toml"), codexConfig(api, model));
    write(settingsPath(folder, app), json(codexHooks(null, folder)));
  }
}

/**
 * Repairs for `doctor --fix`. Each returns what it changed (or would, with dryRun), and
 * keeps everything the person added: other hooks, permissions, MCP servers, settings.
 */
export const repairs = {
  hooks(folder, _cfg, { dryRun }) {
    if (!dryRun) installHooks(folder);
    return [".binference/hooks/"];
  },
  launcher(folder, _cfg, { dryRun }) {
    if (!dryRun) installLauncher(folder);
    return ["start"];
  },
  settings(folder, cfg, { dryRun }) {
    const path = settingsPath(folder, cfg.app);
    const current = readJson(path);
    const next = cfg.app === "codex" ? codexHooks(current, folder) : claudeSettings(current);
    const changed = [];
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      if (!dryRun) write(path, json(next));
      changed.push(cfg.app === "codex" ? ".codex/hooks.json" : ".claude/settings.json");
    }
    if (cfg.app === "codex") {
      const toml = join(folder, ".codex", "config.toml");
      if (!existsSync(toml)) {
        if (!dryRun) write(toml, codexConfig(cfg.api_url, cfg.model ?? DEFAULT_MODEL.codex));
        changed.push(".codex/config.toml");
      } else if (!readFileSync(toml, "utf8").includes("[mcp_servers.binference]")) {
        if (!dryRun) write(toml, `${readFileSync(toml, "utf8").replace(/\n*$/, "\n\n")}${mcpSection(cfg.api_url)}`);
        changed.push(".codex/config.toml");
      }
    }
    if (!dryRun) ensureGitignore(folder);
    return changed;
  },
  skill(folder, _cfg, { dryRun }) {
    if (!dryRun) installOwnSkill(folder);
    return [".claude/skills/binference/", ".agents/skills/binference/"];
  },
};

export function readConfig(folder) {
  return readFolder(folder).cfg;
}

export function readKey(folder) {
  return readFolder(folder).key;
}
