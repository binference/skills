// Reads what an agent is about to run: Binance Agentic Wallet commands (`baw ...`) inside a
// shell command, and Binance MCP Server tool calls. Pure functions, no I/O, so every rule
// the hooks apply can be tested on its own.

/** Binance's own chain ids, as `baw --binanceChainId` takes them. */
export const BSC = "56";

/** Native coins, as Binance's tools write them on EVM chains. */
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * Dollar stablecoins per chain, from the wallet skill's Common Token Addresses: an amount in
 * one of them is its own dollar value. EVM addresses lowercase.
 */
export const STABLECOINS = {
  56: [
    "0x55d398326f99059ff775485246999027b3197955", // USDT
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    "0xce24439f2d9c6a2289f741120fe202248b666666", // U
    "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", // USD1
  ],
  1: [
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  ],
  8453: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], // USDC
  CT_501: [
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  ],
};

/** The stablecoin a chain's trades are priced into for the rules: USDT on BNB Chain. */
export const QUOTE_TOKEN = {
  56: "0x55d398326f99059ff775485246999027b3197955",
  1: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  CT_501: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/** An address as the rules compare it: EVM lowercase, anything else as written. */
export function tokenKey(address) {
  if (typeof address !== "string") return null;
  const value = address.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value || null;
}

export function isStablecoin(chain, token) {
  const list = STABLECOINS[chain] ?? [];
  return token !== null && list.includes(tokenKey(token));
}

/**
 * Splits a shell command into its simple commands and their words, the way a shell would
 * for the cases agents write: quotes, escapes, `&&`, `||`, `;`, `|`, `&`, new lines and
 * `( ... )`. Command substitutions (`$(...)`, backticks, `<(...)`) are read as commands of
 * their own; in the word they leave a placeholder. Nothing is run.
 */
export function shellCommands(command, depth = 0) {
  const commands = [];
  const nested = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  // The index of the `)` that closes the `(` at `open`, or the end of the text.
  const closing = (open) => {
    let level = 0;
    let inner = null;
    for (let j = open; j < command.length; j += 1) {
      const char = command[j];
      if (inner) {
        if (char === inner) inner = null;
        else if (char === "\\" && inner === '"') j += 1;
        continue;
      }
      if (char === "'" || char === '"') inner = char;
      else if (char === "(") level += 1;
      else if (char === ")") {
        level -= 1;
        if (level === 0) return j;
      }
    }
    return command.length - 1;
  };
  const substitute = (innerStart, end) => {
    nested.push(command.slice(innerStart, end));
    word += "$(…)";
    inWord = true;
    return end;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if ((char === "$" || ((char === "<" || char === ">") && quote === null)) && next === "(") {
      i = substitute(i + 2, closing(i + 1));
      continue;
    }
    if (char === "`") {
      let end = i + 1;
      while (end < command.length && command[end] !== "`") end += command[end] === "\\" ? 2 : 1;
      i = substitute(i + 1, Math.min(end, command.length));
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < command.length && '"\\$`'.includes(next)) {
        i += 1;
        word += command[i];
      }
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < command.length) {
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i += 1;
    } else if (";\n|&()".includes(char)) {
      endCommand();
      if ((char === "|" || char === "&") && next === char) i += 1;
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  if (depth < 4) for (const inner of nested) commands.push(...shellCommands(inner, depth + 1));
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL = /^(.*\/)?(ba|z|da|k|fi|)sh$/;
const RESERVED = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "builtin", "nohup", "chronic", "unbuffer"]);
const LOOKUPS = new Set(["which", "type", "whereis", "hash", "man"]);

/** Skips a wrapper's options; the ones in `withValue` take the next word. */
const skipFlags = (withValue) => (words, i) => {
  while (i < words.length && words[i].startsWith("-") && words[i] !== "--") {
    const flag = words[i];
    i += 1;
    if (withValue.includes(flag)) i += 1;
  }
  return words[i] === "--" ? i + 1 : i;
};

/** Programs that run the command after their own options. */
const WRAPPERS = {
  sudo: skipFlags(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D"]),
  doas: skipFlags(["-u", "-C"]),
  env: (words, i) => {
    let at = skipFlags(["-u", "-C", "-S", "-P"])(words, i);
    while (at < words.length && ASSIGNMENT.test(words[at])) at += 1;
    return at;
  },
  command: skipFlags([]),
  exec: skipFlags(["-a"]),
  time: skipFlags(["-f", "-o"]),
  nice: skipFlags(["-n"]),
  ionice: skipFlags(["-c", "-n", "-p", "-P", "-u"]),
  stdbuf: skipFlags(["-i", "-o", "-e"]),
  caffeinate: skipFlags(["-t", "-w"]),
  watch: skipFlags(["-n", "-q"]),
  xargs: skipFlags(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-R", "-S"]),
  // timeout [options] <duration> <command>
  timeout: (words, i) => skipFlags(["-s", "-k"])(words, i) + 1,
};

/** Runs a package's binary: npx, pnpx, bunx, `npm exec`, `pnpm dlx`, `yarn dlx`, `bun x`. */
function packageRunner(words, i) {
  const name = words[i].split("/").pop();
  let at;
  if (name === "npx" || name === "pnpx" || name === "bunx") at = i + 1;
  else if (["npm", "pnpm", "yarn", "bun"].includes(name) && ["exec", "x", "dlx"].includes(words[i + 1])) at = i + 2;
  else return null;
  for (; at < words.length; at += 1) {
    const word = words[at];
    if (word === "--") continue;
    if (word.startsWith("-")) {
      if (word === "-p" || word === "--package") at += 1;
      continue;
    }
    if (word.startsWith("@binance/agentic-wallet") || word === "baw") return { kind: "baw", from: i, args: words.slice(at + 1) };
    return null;
  }
  return null;
}

/** What a simple command runs, past assignments and wrappers: `baw`, a script, a lookup, or null. */
function invocation(words) {
  let i = 0;
  for (let guard = 0; guard < 32 && i < words.length; guard += 1) {
    const word = words[i];
    const name = word.split("/").pop();
    if (ASSIGNMENT.test(word)) i += 1;
    else if (name === "command" && /^-[vV]$/.test(words[i + 1] ?? "")) return { kind: "lookup", from: i };
    else if (RESERVED.has(word)) i += 1;
    else if (LOOKUPS.has(name)) return { kind: "lookup", from: i };
    else if (WRAPPERS[name]) i = WRAPPERS[name](words, i + 1);
    else if (name === "eval") return { kind: "script", from: i, text: words.slice(i + 1).join(" ") };
    else if (SHELL.test(word)) {
      const flag = words.findIndex((part, at) => at > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(part));
      return flag > 0 && words[flag + 1] !== undefined ? { kind: "script", from: i, text: words[flag + 1] } : null;
    } else if (name === "baw") return { kind: "baw", from: i, args: words.slice(i + 1) };
    else return packageRunner(words, i);
  }
  return null;
}

/** Whether a word names the wallet CLI: as a program, a package, or inside a quoted script. */
function mentionsWallet(word) {
  return (
    /(^|\/)baw$/.test(word) ||
    word.includes("@binance/agentic-wallet") ||
    /(^|[\s;&|(){}=`'"])baw($|[\s;&|)}`'"])/.test(word)
  );
}

/** A `baw` call: its command words, its flags and its bare arguments. */
export function parseBaw(args) {
  const path = [];
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith("-") && path.length < 3) {
    path.push(args[i]);
    i += 1;
  }
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
        i += 1;
        flags[arg.slice(2)] = args[i];
      } else flags[arg.slice(2)] = true;
    } else if (arg === "-h") flags.help = true;
    else positional.push(arg);
  }
  return { path, flags, positional };
}

/**
 * The `baw` calls in a shell command, however they are run: directly, through wrappers,
 * package runners, `sh -c`, `eval` or substitutions. `opaque` is true when the command
 * names the wallet CLI in a way this cannot read, such as `echo "baw ..." | sh`.
 */
export function analyzeShell(command, depth = 0) {
  const calls = [];
  let opaque = false;
  if (typeof command !== "string") return { calls, opaque };
  if (!command.includes("baw") && !command.includes("agentic-wallet")) return { calls, opaque };
  for (const words of shellCommands(command)) {
    const found = invocation(words);
    if (found?.kind === "baw") calls.push(parseBaw(found.args));
    if (found?.kind === "script") {
      const inner = depth < 4 ? analyzeShell(found.text, depth + 1) : { calls: [], opaque: true };
      calls.push(...inner.calls);
      opaque ||= inner.opaque;
    }
    // Every mention must belong to what was read above, or the command is not understood.
    const from = found ? found.from : words.length;
    if (words.some((word, at) => at < from && mentionsWallet(word))) opaque = true;
  }
  return { calls, opaque };
}

export function bawCalls(command) {
  return analyzeShell(command).calls;
}

const text = (value) => (typeof value === "string" && value !== "" ? value : null);
const qty = (value) => (typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? value : null);

/** `baw` groups that never move value, and the read-only commands of the others. */
const READ_ONLY_GROUPS = new Set(["skill-check", "cli-check", "auth", "signal", "tracker", "leaderboard", "help"]);
const READS = {
  wallet: ["status", "address", "balance", "tx-history", "settings", "left-quota", "chains", "gas-price"],
  "market-order": ["quote", "list"],
  "limit-order": ["list"],
  defi: ["protocol-list", "protocol-info", "investment-list", "investment-info", "position", "preview"],
  prediction: ["market", "category", "position", "order"],
  "x402-payment": ["preview"],
  "contract-call": ["preview"],
  "sign-message": ["preview", "result", "history"],
  approvals: ["list", "detail"],
};

/**
 * What a `baw` call does when it may change something: the action as the cockpit names it
 * and what it moves. Null only for commands known to read. A command not known here is a
 * write whose value cannot be told (`unparsed`), so the rules send it to the person.
 */
export function classifyBaw(call) {
  const [group, sub, third] = call.path;
  const f = call.flags;
  if (!group || f.help === true || f.version === true || sub === "help" || third === "help") return null;
  if (READ_ONLY_GROUPS.has(group) || READS[group]?.includes(sub)) return null;
  if (sub === undefined && READS[group]) return null; // `baw wallet` alone prints its help
  const chain = text(f.binanceChainId);
  const base = { chain, from_token: null, from_qty: null, to_token: null, order_id: null, detail: null };
  const key = call.path.join(" ");
  switch (`${group} ${sub}`) {
    case "market-order swap":
      return {
        ...base,
        action: "swap",
        command: key,
        from_token: tokenKey(f.fromToken),
        from_qty: qty(f.fromTokenQty),
        to_token: tokenKey(f.toToken),
      };
    case "limit-order buy":
    case "limit-order sell":
      return {
        ...base,
        action: "limit_order",
        command: key,
        from_token: tokenKey(f.fromToken),
        from_qty: qty(f.fromTokenQty),
        to_token: tokenKey(f.toToken),
        detail: {
          side: sub === "buy" ? "BUY" : "SELL",
          type: "LIMIT",
          ...(qty(f.triggerPrice) ? { price: f.triggerPrice } : {}),
        },
      };
    case "limit-order cancel":
      return { ...base, action: "cancel_order", command: key, order_id: text(f.strategyId) };
    case "wallet send":
      return {
        ...base,
        action: "send",
        command: key,
        from_token: tokenKey(f.tokenAddress),
        // `--max` sends everything: no amount to check, so the rules treat it as unknown.
        from_qty: qty(f.amount),
      };
    case "wallet speed-up":
    case "wallet cancel":
      return { ...base, action: "other", command: key };
    case "defi deposit":
    case "defi lp-add":
      return {
        ...base,
        action: "defi",
        command: key,
        from_token: tokenKey(f.tokenAddress),
        from_qty: qty(f.amount),
        detail: { type: sub === "deposit" ? "DEPOSIT" : "LP_ADD" },
      };
    case "defi redeem":
    case "defi lp-remove":
    case "defi claim":
      return {
        ...base,
        action: "defi",
        command: key,
        to_token: tokenKey(f.tokenAddress),
        detail: { type: sub.toUpperCase().replace("-", "_") },
      };
    case "prediction trade":
      if (third === "quote" || third === undefined) return null;
      if (third === "place-order") {
        return {
          ...base,
          action: "prediction",
          command: key,
          order_id: text(f.quoteId),
          detail: { type: text(f.orderType)?.toUpperCase() ?? "MARKET" },
        };
      }
      if (third === "cancel") return { ...base, action: "cancel_order", command: key };
      if (third === "redeem") return { ...base, action: "prediction", command: key, detail: { type: "REDEEM" } };
      break;
    case "contract-call execute":
      return { ...base, action: "contract_call", command: key, order_id: text(f.requestId) };
    case "sign-message execute":
      // A signed message can authorize a transfer (a permit): it moves value.
      return { ...base, action: "sign_message", command: key, order_id: text(f.requestId), moves_value: true };
    case "x402-payment sign":
      return { ...base, action: "x402_payment", command: key, order_id: text(f.paymentId) };
    case "approvals revoke":
      return { ...base, action: "approval_revoke", command: key, from_token: tokenKey(f.tokenContract) };
  }
  return { ...base, action: "other", command: key || "baw", moves_value: true, unparsed: true };
}

/** A write the hooks could not read: it may move value, and its value is unknown. */
const UNREAD = {
  action: "other",
  command: "unread baw call",
  chain: null,
  from_token: null,
  from_qty: null,
  to_token: null,
  order_id: null,
  detail: null,
  moves_value: true,
  unparsed: true,
};

/** The writes a shell command would make through `baw`, in order. */
export function bawWrites(command) {
  const { calls, opaque } = analyzeShell(command);
  const writes = calls.map((call) => ({ call, write: classifyBaw(call) })).filter((entry) => entry.write !== null);
  if (opaque) writes.push({ call: null, write: { ...UNREAD } });
  return writes;
}

/** Binance's MCP Server tools, as the agent apps name them: `mcp__binance-mcp-server__<tool>`. */
export function isBinanceMcpTool(toolName) {
  return typeof toolName === "string" && /^mcp__binance[\w-]*__/.test(toolName);
}

const MCP_READ_VERBS = new Set(["get", "list", "query", "fetch", "search", "show", "check", "ping"]);
const MCP_ORDER = new Set(["new", "place", "create", "submit", "order", "buy", "sell", "oco", "oto", "otoco", "amend", "modify", "replace", "batch"]);
const MCP_MOVES = new Set([
  "withdraw", "withdrawal", "send", "pay", "payment", "convert", "swap", "borrow", "repay", "loan", "lend",
  "subscribe", "purchase", "redeem", "stake", "unstake", "mint", "burn", "claim", "dust",
]);
const MCP_READS = new Set([
  "account", "balance", "balances", "ticker", "tickers", "price", "prices", "depth", "book", "orderbook",
  "klines", "kline", "candles", "avg", "stats", "info", "exchange", "history", "status", "positions",
  "position", "snapshot", "trades", "orders", "rate", "rates", "limits", "fee", "fees", "config", "time",
  "server", "detail", "details", "assets", "asset", "symbols", "symbol", "markets", "market",
]);

/**
 * What a Binance MCP Server tool call does. Its docs list no tool names, so this reads them
 * by their words, and only names that clearly read (prices, books, balances, history) pass
 * as reads. An order or a cancel is named as such; anything that moves funds, or that
 * cannot be told, is a write the rules value as unknown.
 */
export function classifyMcp(toolName, input = {}) {
  if (!isBinanceMcpTool(toolName)) return null;
  const tool = toolName.replace(/^mcp__binance[\w-]*__/, "").toLowerCase();
  const words = tool.split(/[_\-.]/).filter(Boolean);
  const has = (set) => words.some((word) => set.has(word));
  let action;
  let movesValue = false;
  let unparsed = false;
  if (MCP_READ_VERBS.has(words[0])) return null;
  if (words.includes("cancel") && !words.some((word) => ["replace", "amend", "new", "place"].includes(word))) {
    action = "exchange_cancel";
  } else if (has(MCP_MOVES)) {
    action = "exchange_transfer";
    movesValue = true;
  } else if (has(MCP_ORDER)) action = "exchange_order";
  else if (words.includes("transfer")) action = "exchange_transfer";
  else if (has(MCP_READS)) return null;
  else {
    action = "exchange_transfer";
    movesValue = true;
    unparsed = true;
  }
  const symbol = typeof input.symbol === "string" ? input.symbol.toUpperCase() : null;
  const detail = {
    tool: tool.slice(0, 64),
    ...(symbol && /^[A-Z0-9]{2,32}$/.test(symbol) ? { pair: symbol } : {}),
    ...(input.side === "BUY" || input.side === "SELL" ? { side: input.side } : {}),
    ...(typeof input.type === "string" && /^[A-Z_]{1,32}$/.test(input.type) ? { type: input.type } : {}),
    ...(qty(String(input.price ?? "")) ? { price: String(input.price) } : {}),
    ...(qty(String(input.quantity ?? "")) ? { quantity: String(input.quantity) } : {}),
  };
  return {
    action,
    command: tool,
    detail,
    quote: action === "exchange_order" ? exchangeDollars(symbol, input) : null,
    ...(movesValue ? { moves_value: true } : {}),
    ...(unparsed ? { unparsed: true } : {}),
  };
}

/**
 * An exchange order's dollar value when the order says it: a quote amount in a dollar
 * stablecoin, or a quantity at a limit price on a dollar pair. Null otherwise.
 */
export function exchangeDollars(symbol, input) {
  if (!symbol || !/(USDT|USDC|FDUSD|USD1|TUSD)$/.test(symbol)) return null;
  const quoteQty = Number(input.quoteOrderQty);
  if (Number.isFinite(quoteQty) && quoteQty > 0) return quoteQty;
  const quantity = Number(input.quantity);
  const price = Number(input.price);
  if (Number.isFinite(quantity) && Number.isFinite(price) && quantity > 0 && price > 0) {
    return quantity * price;
  }
  return null;
}

/**
 * The shell command a tool call runs, from the hook's input: a string in Claude Code and
 * Codex; older Codex versions sent the program and its arguments, as in ["bash", "-lc", "..."].
 */
export function shellCommandOf(toolInput) {
  const command = toolInput?.command ?? toolInput?.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const shell = SHELL.test(command[0] ?? "");
    const flag = command.findIndex((part) => /^-\w*c$/.test(part));
    if (shell && flag > 0 && command[flag + 1] !== undefined) return command[flag + 1];
    return command.join(" ");
  }
  return null;
}

/** What a tool call would change, as cockpit actions: `baw` writes in a shell, or a Binance MCP write. */
export function hookWrites(hook) {
  if (isBinanceMcpTool(hook?.tool_name)) {
    const write = classifyMcp(hook.tool_name, hook.tool_input ?? {});
    return write ? [{ chain: null, from_token: null, from_qty: null, to_token: null, order_id: null, ...write }] : [];
  }
  const command = shellCommandOf(hook?.tool_input);
  return command ? bawWrites(command).map((entry) => entry.write) : [];
}

/** The files that hold the owner's limits and the hooks themselves. */
const PROTECTED = [
  [/(^|[^\w.-])\.binference([/\s"'`;|&)]|$)/, ".binference/"],
  [/\.claude\/settings(\.local)?\.json/, ".claude/settings.json"],
  [/(^|[^\w.-])\.codex\//, ".codex/"],
  [/(^|[^\w.-])\.mcp\.json/, ".mcp.json"],
];

/**
 * The protected file a tool call names, or null. A shell command is read as a whole; for
 * Codex's other tools (such as editing a file) their whole input is read.
 */
export function protectedTarget(hook) {
  if (isBinanceMcpTool(hook?.tool_name) || String(hook?.tool_name ?? "").startsWith("mcp__")) return null;
  const command = shellCommandOf(hook?.tool_input);
  const textToRead = command ?? (hook?.tool_input ? JSON.stringify(hook.tool_input) : "");
  for (const [pattern, name] of PROTECTED) if (pattern.test(textToRead)) return name;
  return null;
}
