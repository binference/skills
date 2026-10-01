// `npx binference link-wallet`: links the agent's Agentic Wallet to its cockpit, so its
// trades count toward a track record checked on BNB Chain. The person runs it in a
// terminal, sees everything the wallet signs, and says yes: it refuses to run without a
// terminal, so an agent cannot sign this itself.
//
// The wallet signs typed data (EIP-712), the one kind `baw sign-message` signs, with
// Developer Mode on. The signature sends no transaction and moves no funds, and this
// checks that the data really is a link message before showing it.

import { resolve } from "node:path";

import { parseJsonOutput } from "../hooks/lib.mjs";
import { CliError } from "./errors.mjs";
import { CLI_VERSION, readConfig, readKey } from "./folder.mjs";
import { run } from "./system.mjs";
import { check, confirm, dim, interactive, line, title } from "./ui.mjs";

const SETTINGS = "Binance App → Agentic Wallet → Settings (top right)";

/** The only fields a link message may hold: no amounts, spenders, tokens or deadlines. */
const LINK_FIELDS = new Set(["statement", "agent", "wallet", "cockpit", "nonce", "issuedAt", "issued_at", "expiresAt", "expires_at", "uri", "version", "chainId"]);
const DOMAIN_FIELDS = new Set(["name", "version", "chainId"]);

/**
 * Why `typedData` is not a plain link message for `address`, or null when it is one. A
 * permit or an order (which can move funds) has other fields, nested values or a
 * verifying contract, and is refused.
 */
export function typedDataProblem(typedData, address) {
  if (!typedData || typeof typedData !== "object") return "it is not typed data";
  const { domain, message, primaryType } = typedData;
  if (!domain || typeof domain !== "object" || !message || typeof message !== "object") return "it has no domain or message";
  const extraDomain = Object.keys(domain).filter((field) => !DOMAIN_FIELDS.has(field));
  if (extraDomain.length > 0) return `its domain has ${extraDomain.join(", ")}`;
  if (domain.chainId !== undefined && Number(domain.chainId) !== 56) return `it is for chain ${domain.chainId}, not BNB Chain`;
  if (typeof primaryType !== "string" || /permit|order|transfer|approv|delegat/i.test(primaryType)) return `its type is ${primaryType}`;
  const extra = Object.keys(message).filter((field) => !LINK_FIELDS.has(field));
  if (extra.length > 0) return `its message has ${extra.join(", ")}`;
  if (Object.values(message).some((value) => value !== null && typeof value === "object")) return "its message has nested values";
  if (typeof message.statement !== "string") return "its message has no statement";
  if (String(message.wallet ?? "").toLowerCase() !== address.toLowerCase()) return "it names another wallet";
  return null;
}

async function baw(args, timeoutMs = 20_000) {
  const parsed = parseJsonOutput((await run("baw", [...args, "--json"], { timeoutMs })) ?? "");
  return parsed?.success === true ? (parsed.data ?? {}) : { error: parsed?.error?.message ?? null };
}

async function post(cfg, key, path, body) {
  try {
    const response = await fetch(`${cfg.api_url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `binference-cli/${CLI_VERSION}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

export async function linkWallet({ folder: path }) {
  if (!interactive()) {
    throw new CliError("needs_terminal", "link-wallet signs with the agent's wallet, so it runs only in a terminal, with a person there.", {
      hint: "Run it yourself: npx binference link-wallet",
    });
  }
  const folder = resolve(path ?? ".");
  const cfg = readConfig(folder);
  const key = readKey(folder);
  if (!cfg || !key) throw new CliError("not_agent_folder", "No agent folder here.", { hint: 'Run this inside the folder "npx binference agent-os" made.' });
  title(`Link ${cfg.name}'s wallet for a track record`);

  const status = await baw(["wallet", "status"], 10_000);
  if (status.status !== "CONNECTED") {
    throw new CliError("wallet_signed_out", "The Agentic Wallet is not signed in here.", {
      hint: 'Start the agent and say "Sign in to Binance Agentic Wallet", then run this again.',
    });
  }
  const addresses = await baw(["wallet", "address"]);
  const address = (addresses.addresses ?? []).find((entry) => entry.binanceChainId === "56")?.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new CliError("no_address", "Could not read the wallet's BNB Chain address from baw.");
  check("ok", "Agentic Wallet signed in", address);

  const settings = await baw(["wallet", "settings"]);
  if (settings.devMode?.enabled !== true) {
    check("todo", "Developer Mode is off", "signing needs it on, once");
    throw new CliError("dev_mode_off", "Developer Mode is off.", { hint: `Turn it on in the ${SETTINGS}, run this again, and turn it off after.` });
  }

  const challenge = await post(cfg, key, "/api/v1/cockpit/wallet/challenge", { address });
  if (challenge.status !== 200) {
    throw new CliError("challenge_failed", challenge.json?.error?.message ?? `binference.io answered HTTP ${challenge.status}.`);
  }
  const typedData = challenge.json?.typed_data;
  const problem = typedDataProblem(typedData, address);
  if (problem) {
    throw new CliError("unexpected_message", `Refusing to sign: this is not a wallet link message (${problem}).`, {
      hint: "Nothing was signed. Tell bInference support.",
    });
  }
  const message = JSON.stringify({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typedData)] });
  const preview = await baw(["sign-message", "preview", "--binanceChainId", "56", "--signType", "EIP712", "--message", message]);
  if (!preview.requestId) throw new CliError("preview_failed", `Binance's wallet would not prepare the signature${preview.error ? `: ${preview.error}` : "."}`);

  line();
  line("  The wallet will sign exactly this. It sends no transaction and moves no funds:");
  line();
  line(`    ${typedData.message.statement}`);
  line();
  for (const [field, value] of Object.entries({ type: typedData.primaryType, ...typedData.domain, ...typedData.message })) {
    if (field !== "statement") line(dim(`    ${field}: ${value}`));
  }
  for (const risk of preview.risks ?? []) line(dim(`    Binance notes: ${risk.message ?? risk.type ?? JSON.stringify(risk)}`));
  line();
  if ((await confirm("Sign it?")) !== true) throw new CliError("not_signed", "Nothing was signed.");

  let signed = await baw(["sign-message", "execute", "--requestId", preview.requestId]);
  if (signed.status === "PENDING_CONFIRMATION" && signed.orderId) {
    line("  Confirm it in the Binance App. Waiting...");
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline && signed.status !== "COMPLETED") {
      await new Promise((resume) => setTimeout(resume, 3_000));
      signed = await baw(["sign-message", "result", "--order-id", signed.orderId]);
    }
  }
  if (signed.status !== "COMPLETED" || !signed.signature) {
    throw new CliError("not_signed", `The wallet did not sign${signed.error ? `: ${signed.error}` : ". Nothing was linked."}`);
  }

  const linked = await post(cfg, key, "/api/v1/cockpit/wallet/link", {
    token: challenge.json.token,
    signature: signed.signature,
    signature_recovery: signed.signatureRecovery ?? null,
  });
  if (linked.status !== 200) throw new CliError("link_failed", linked.json?.error?.message ?? `binference.io answered HTTP ${linked.status}.`);
  check("ok", "Wallet linked", linked.json.wallet);
  line();
  line("  From the next session on, the agent's BNB Chain trades go to its cockpit, and each one");
  line("  is checked on chain before it counts. You choose there whether the record is public.");
  line(`  Turn Developer Mode off again now: ${SETTINGS}.`);
  line(dim(`  Cockpit: ${cfg.cockpit_url}\n`));
}
