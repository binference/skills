// The command line: reads the command and its flags strictly, prints help for every
// command, runs it, and turns any error into a short message (or JSON with --json) and an
// exit code: 0 done, 1 failed, 2 wrong usage.

import { parseArgs } from "node:util";

import { CliError, usageError } from "./errors.mjs";
import { apiUrl, checkModel, CLI_VERSION } from "./folder.mjs";
import { emit, isJson, line, printError, setJson } from "./ui.mjs";

const JSON_FLAG = { type: "boolean", help: "Print JSON for scripts and agents instead of text" };
const HELP_FLAG = { type: "boolean", short: "h", help: "Show this help" };

const COMMANDS = {
  "agent-os": {
    args: "[name]",
    summary: "Set up a folder for an agent on Binance Agent OS",
    options: {
      app: { type: "string", value: "claude|codex", help: "Which app runs it (needed without a terminal when both are installed)" },
      model: { type: "string", value: "<id>", help: "Its model (any id on binference.io/models)" },
      yes: { type: "boolean", short: "y", help: "Install Binance's wallet CLI without asking" },
      sandbox: { type: "boolean", help: "Turn on Claude Code's sandbox, so shell commands cannot touch the folder's limits" },
      "no-wait": { type: "boolean", help: "Show the sign-in code and stop; finish later with --resume" },
      resume: { type: "boolean", help: "Finish a sign-in started with --no-wait" },
      json: JSON_FLAG,
    },
    run: async ({ values, positionals }) => {
      const app = { claude: "claude_code", "claude-code": "claude_code", claude_code: "claude_code", codex: "codex" }[values.app ?? ""];
      if (values.app !== undefined && !app) throw usageError(`--app is claude or codex, not "${values.app}".`);
      if (values["no-wait"] && values.resume) throw usageError("Use --no-wait or --resume, not both.");
      const { agentOs } = await import("./agent-os.mjs");
      await agentOs({
        name: positionals[0],
        app,
        model: checkModel(values.model),
        api: apiUrl(),
        yes: values.yes ?? false,
        sandbox: values.sandbox ?? false,
        noWait: values["no-wait"] ?? false,
        resume: values.resume ?? false,
      });
    },
  },
  doctor: {
    args: "[folder]",
    summary: "Check an agent folder (the one you are in by default)",
    options: {
      fix: { type: "boolean", help: "Repair what failed, keeping your own settings" },
      "dry-run": { type: "boolean", help: "With --fix: show what would change, change nothing" },
      json: JSON_FLAG,
    },
    run: async ({ values, positionals }) => {
      if (values["dry-run"] && !values.fix) throw usageError("--dry-run goes with --fix.");
      const { doctor } = await import("./doctor.mjs");
      await doctor({ folder: positionals[0], fix: values.fix ?? false, dryRun: values["dry-run"] ?? false });
    },
  },
  start: {
    args: "[app arguments]",
    summary: "Start the folder's app on bInference (./start in the folder does the same)",
    passthrough: true,
    notes: "Everything after `start` goes to Claude Code or Codex. Put -- first to pass --help to them.",
    run: async ({ rest }) => {
      const { start } = await import("./start.mjs");
      await start({ folder: ".", args: rest });
    },
  },
  "link-wallet": {
    args: "[folder]",
    summary: "Link the agent's wallet for a track record checked on BNB Chain (you sign; it moves nothing)",
    options: {},
    notes: "Runs only in a terminal: the wallet signs only with a person's yes.",
    run: async ({ positionals }) => {
      const { linkWallet } = await import("./link-wallet.mjs");
      await linkWallet({ folder: positionals[0] });
    },
  },
};

const EXIT_CODES = "Exit codes: 0 done, 1 failed (doctor: a check failed), 2 wrong usage.";

function optionLines(options) {
  return Object.entries({ ...options, help: HELP_FLAG }).map(([name, option]) => {
    const flag = `${option.short ? `-${option.short}, ` : ""}--${name}${option.value ? ` ${option.value}` : ""}`;
    return `      ${flag.padEnd(28)} ${option.help}`;
  });
}

function mainHelp() {
  const lines = [`bInference ${CLI_VERSION}`, "", "Usage: npx binference <command> [options]", ""];
  for (const [name, spec] of Object.entries(COMMANDS)) lines.push(`  ${`${name} ${spec.args}`.padEnd(32)} ${spec.summary}`);
  lines.push("", "Run npx binference <command> --help for its options.", EXIT_CODES, "Docs: https://docs.binference.io/agent-os");
  return lines.join("\n");
}

function commandHelp(name) {
  const spec = COMMANDS[name];
  const lines = [`Usage: npx binference ${name} ${spec.args}`, "", `  ${spec.summary}`, ""];
  if (!spec.passthrough) lines.push("Options:", ...optionLines(spec.options), "");
  if (spec.notes) lines.push(spec.notes, "");
  lines.push(EXIT_CODES);
  return lines.join("\n");
}

/** The closest name within two edits, for "did you mean". */
function closest(word, names) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const current = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length];
  };
  const best = names.map((name) => [name, distance(word, name)]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

function parse(name, args) {
  const spec = COMMANDS[name];
  const options = { ...spec.options, help: HELP_FLAG };
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    const unknown = /'(-{1,2}[^']+)'/.exec(error.message)?.[1];
    if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && unknown) {
      const guess = closest(unknown.replace(/^-+/, ""), Object.keys(options));
      throw usageError(`Unknown option ${unknown} for ${name}.`, guess ? `Did you mean --${guess}? See: npx binference ${name} --help` : `See: npx binference ${name} --help`);
    }
    throw usageError(`${error.message.split(". ")[0]}.`, `See: npx binference ${name} --help`);
  }
}

async function main(argv) {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    line(mainHelp());
    return;
  }
  if (name === "--version" || name === "-v" || name === "-V") {
    line(CLI_VERSION);
    return;
  }
  const spec = COMMANDS[name];
  if (!spec) {
    const guess = closest(name, Object.keys(COMMANDS));
    throw usageError(`Unknown command "${name}".`, guess ? `Did you mean "${guess}"? See: npx binference --help` : "See: npx binference --help");
  }
  if (spec.passthrough) {
    if (rest[0] === "--help" || rest[0] === "-h") {
      line(commandHelp(name));
      return;
    }
    await spec.run({ rest: rest[0] === "--" ? rest.slice(1) : rest });
    return;
  }
  const parsed = parse(name, rest);
  if (parsed.values.help) {
    line(commandHelp(name));
    return;
  }
  await spec.run(parsed);
}

const argv = process.argv.slice(2);
// Known before parsing, so even a usage error comes out as JSON.
setJson(argv[0] !== "start" && argv.includes("--json"));
try {
  await main(argv);
} catch (error) {
  const known = error instanceof CliError;
  const code = known ? error.code : "internal";
  const message = known ? error.message : `Unexpected error: ${error?.message ?? error}`;
  const hint = known ? error.hint : "Set BINF_DEBUG=1 to see where it happened, and report it at https://github.com/binference/skills/issues.";
  if (isJson()) emit({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
  else printError(message, hint);
  if (!known && process.env.BINF_DEBUG) process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = known ? error.exitCode : 1;
}
