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
 * for the cases agents write: quotes, escapes, `&&`, `||`, `;`, `|` and new lines. It does
 * not run substitutions; `$(...)` stays a word.
 */
export function shellCommands(command) {
  const commands = [];
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
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
        word += command[(i += 1)];
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") {
        word += command[i + 1];
        inWord = true;
      }
      i += 1;
    } else if (char === ";" || char === "\n" || char === "|" || char === "&") {
      endCommand();
      if ((char === "|" || char === "&") && command[i + 1] === char) i += 1;
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The `baw` invocations in a shell command: its words after the program, however it was run. */
function bawWords(words) {
  let start = 0;
  // Leading assignments (FOO=bar baw ...) and wrappers.
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start += 1;
  const wrappers = new Set(["sudo", "env", "command", "exec", "time", "nohup"]);
  while (start < words.length && wrappers.has(words[start])) start += 1;
  const program = words[start] ?? "";
  if (program === "baw" || program.endsWith("/baw")) return words.slice(start + 1);
  // npx @binance/agentic-wallet ..., npx -y @binance/agentic-wallet@1.10.0 ...
  if (program === "npx" || program === "pnpx" || program.endsWith("/npx")) {
    const rest = words.slice(start + 1).filter((w) => !w.startsWith("-"));
    if (rest[0]?.startsWith("@binance/agentic-wallet")) {
      const at = words.indexOf(rest[0], start + 1);
      return words.slice(at + 1);
    }
  }
  return null;
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
        flags[arg.slice(2)] = args[(i += 1)];
      } else flags[arg.slice(2)] = true;
    } else positional.push(arg);
  }
  return { path, flags, positional };
}

/** Every `baw` call in a shell command, parsed. */
export function bawCalls(command) {
  if (typeof command !== "string" || !command.includes("baw") && !command.includes("agentic-wallet")) {
    return [];
  }
  const calls = [];
  for (const words of shellCommands(command)) {
    const args = bawWords(words);
    if (args) calls.push(parseBaw(args));
  }
  return calls;
}

const text = (value) => (typeof value === "string" && value !== "" ? value : null);
const qty = (value) => (typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? value : null);

/**
 * What a `baw` call does, when it changes something: the action as the cockpit names it and
 * what it moves. Null for reads. `pricing` is the amount the rules value in dollars.
 */
export function classifyBaw(call) {
  const [group, sub, third] = call.path;
  const f = call.flags;
  const chain = text(f.binanceChainId);
  const base = { chain, from_token: null, from_qty: null, to_token: null, order_id: null, detail: null };
  const key = `${group} ${sub}${third ? ` ${third}` : ""}`;
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
      return null;
    case "contract-call execute":
      return { ...base, action: "contract_call", command: key, order_id: text(f.requestId) };
    case "sign-message execute":
      return { ...base, action: "sign_message", command: key, order_id: text(f.requestId) };
    case "x402-payment sign":
      return { ...base, action: "x402_payment", command: key, order_id: text(f.paymentId) };
    case "approvals revoke":
      return { ...base, action: "approval_revoke", command: key, from_token: tokenKey(f.tokenContract) };
    default:
      return null;
  }
}

/** The writes a shell command would make through `baw`, in order. */
export function bawWrites(command) {
  return bawCalls(command)
    .map((call) => ({ call, write: classifyBaw(call) }))
    .filter((entry) => entry.write !== null);
}

/** Binance's MCP Server tools, as the agent apps name them: `mcp__binance-mcp-server__<tool>`. */
export function isBinanceMcpTool(toolName) {
  return typeof toolName === "string" && /^mcp__binance[\w-]*__/.test(toolName);
}

/**
 * What a Binance MCP Server tool call does. Its docs list no tool names, so this reads them
 * by what they say: an order placed, cancelled, or funds moved inside the sub-account. Reads
 * (prices, books, balances) are null.
 */
export function classifyMcp(toolName, input = {}) {
  if (!isBinanceMcpTool(toolName)) return null;
  const tool = toolName.replace(/^mcp__binance[\w-]*__/, "").toLowerCase();
  const word = (pattern) => new RegExp(`(^|_)(${pattern})(_|$)`).test(tool);
  let action = null;
  if (word("cancel|cancel_all")) action = "exchange_cancel";
  else if (word("transfer")) action = "exchange_transfer";
  else if ((word("new|place|create|submit") && /order|trade/.test(tool)) || word("buy|sell|convert|borrow|repay")) {
    action = "exchange_order";
  }
  // Everything else reads: prices, books, balances, open orders, history.
  if (action === null) return null;
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
 * The shell command a tool call runs, from the hook's input: Claude Code's Bash sends a
 * string; Codex may send the program and its arguments, as in ["bash", "-lc", "<script>"].
 */
export function shellCommandOf(toolInput) {
  const command = toolInput?.command ?? toolInput?.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const shell = /(^|\/)(ba|z|da)?sh$/.test(command[0] ?? "");
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
    return write ? [{ ...write, chain: null, from_token: null, from_qty: null, to_token: null, order_id: null }] : [];
  }
  const command = shellCommandOf(hook?.tool_input);
  return command ? bawWrites(command).map((entry) => entry.write) : [];
}
