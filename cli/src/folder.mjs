// Writes an agent folder: the house rules, the app's settings, the hooks and the key.
// Everything the agent app needs lives in the folder; nothing global is touched.

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

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_VERSION = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).version;

/** The model each app starts on; any model on binference.io/models works. */
export const DEFAULT_MODEL = {
  claude_code: "anthropic/claude-sonnet-5.5",
  codex: "openai/gpt-6.1-sol",
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
  if (mode) chmodSync(path, mode);
}

/** Copies the hooks into <folder>/.binference/hooks, replacing older copies. */
export function installHooks(folder) {
  const target = join(folder, ".binference", "hooks");
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(join(PACKAGE, "hooks"))) {
    if (file.endsWith(".mjs")) copyFileSync(join(PACKAGE, "hooks", file), join(target, file));
  }
  return target;
}

/** Copies the bInference skill into the folder, where both apps read skills. */
export function installOwnSkill(folder) {
  // Packed with the CLI on npm; beside it in the repository.
  const source = [join(PACKAGE, "skills", "binference"), join(PACKAGE, "..", "skills", "binference")].find(
    (path) => existsSync(join(path, "SKILL.md")),
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

function claudeHooks() {
  const hook = (file, timeout) => ({
    type: "command",
    command: `node "$CLAUDE_PROJECT_DIR/.binference/hooks/${file}"`,
    timeout,
  });
  return {
    SessionStart: [{ hooks: [hook("session-start.mjs", 20)] }],
    PreToolUse: [{ matcher: "Bash|mcp__binance.*", hooks: [hook("pre-tool.mjs", 30)] }],
    PostToolUse: [{ matcher: "Bash|mcp__binance.*", hooks: [hook("post-tool.mjs", 15)] }],
    Stop: [{ hooks: [hook("stop.mjs", 10)] }],
  };
}

function codexHooks(folder) {
  const hook = (file, timeout) => ({
    type: "command",
    command: `node "${join(folder, ".binference", "hooks", file)}"`,
    timeout,
  });
  // Codex names its shell tool differently across versions: the hook reads the command
  // itself, so it matches every tool and leaves anything that is not a trade at once.
  return {
    hooks: {
      SessionStart: [{ hooks: [hook("session-start.mjs", 20)] }],
      PreToolUse: [{ hooks: [hook("pre-tool.mjs", 30)] }],
      PostToolUse: [{ hooks: [hook("post-tool.mjs", 15)] }],
      UserPromptSubmit: [{ hooks: [hook("prompt.mjs", 5)] }],
      Stop: [{ hooks: [hook("stop.mjs", 10)] }],
    },
  };
}

/** The agent can never read its own key or rewrite its own brakes, whatever a prompt says. */
const PROTECTED = [
  "Read(./.binference/key)",
  "Edit(./.binference/**)",
  "Edit(./.claude/settings.json)",
  "Edit(./.codex/**)",
  "Edit(./.mcp.json)",
];

export function writeFolder(folder, { api, app, key, cockpit, model }) {
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

  if (!existsSync(join(folder, "AGENTS.md"))) {
    copyFileSync(join(PACKAGE, "templates", "AGENTS.md"), join(folder, "AGENTS.md"));
  }
  if (!existsSync(join(folder, "CLAUDE.md"))) write(join(folder, "CLAUDE.md"), "@AGENTS.md\n");
  write(
    join(folder, ".gitignore"),
    [
      "# bInference: the key and local state never leave this machine.",
      ".binference/key",
      ".binference/state.json",
      ".binference/outbox.jsonl",
      ".binference/hooks.log*",
      "",
    ].join("\n"),
  );

  if (app === "claude_code") {
    // Claude Code takes its login only from its own config or the environment, never from
    // a folder: `npx binference start` passes the key and the address (launchEnv below).
    write(
      join(folder, ".claude", "settings.json"),
      json({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { deny: PROTECTED },
        hooks: claudeHooks(),
        enabledMcpjsonServers: ["binference"],
      }),
    );
    write(
      join(folder, ".mcp.json"),
      json({
        mcpServers: {
          binference: {
            type: "http",
            url: `${api}/api/mcp`,
            headers: { Authorization: "Bearer ${BINF_API_KEY}" },
          },
        },
      }),
    );
  } else {
    write(
      join(folder, ".codex", "config.toml"),
      [
        "# bInference is set as the model provider when `npx binference start` launches Codex:",
        "# Codex takes a provider only from your own config or the command line.",
        `model = "${model}"`,
        // Web search on every call reserves many rounds of searching up front (docs: Codex).
        'web_search = "disabled"',
        "",
        "[mcp_servers.binference]",
        `url = "${api}/api/mcp"`,
        'bearer_token_env_var = "BINF_API_KEY"',
        "",
      ].join("\n"),
    );
    write(join(folder, ".codex", "hooks.json"), json(codexHooks(folder)));
  }
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
    `model_providers.binference={name="bInference",base_url="${api}/api/v1",env_key="BINF_API_KEY",wire_api="responses"}`,
  ];
}

export function readConfig(folder) {
  try {
    return JSON.parse(readFileSync(join(folder, ".binference", "config.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readKey(folder) {
  try {
    const key = readFileSync(join(folder, ".binference", "key"), "utf8").trim();
    return key.startsWith("binf_") ? key : null;
  } catch {
    return null;
  }
}
