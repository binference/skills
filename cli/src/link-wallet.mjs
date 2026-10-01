// `npx binference link-wallet`: links the agent's Agentic Wallet to its cockpit, so its
// trades count toward a track record checked on BNB Chain. The person runs it, sees exactly
// what the wallet signs, and says yes: the agent never signs this itself.
//
// The wallet signs typed data (EIP-712), the one kind `baw sign-message` signs, with
// Developer Mode on. The signature sends no transaction and moves no funds.

import { resolve } from "node:path";

import { parseJsonOutput } from "../hooks/lib.mjs";
import { readConfig, readKey } from "./folder.mjs";
import { run } from "./system.mjs";
import { check, confirm, dim, fail, line, title } from "./ui.mjs";

const SETTINGS = "Binance App → Agentic Wallet → Settings (top right)";

async function baw(args, timeoutMs = 20_000) {
  const output = await run("baw", [...args, "--json"], { timeoutMs });
  const parsed = parseJsonOutput(output ?? "");
  return parsed?.success === true ? (parsed.data ?? {}) : { error: parsed?.error?.message ?? null };
}

async function post(cfg, key, path, body) {
  try {
    const response = await fetch(`${cfg.api_url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

export async function linkWallet({ folder: path }) {
  const folder = resolve(path ?? ".");
  const cfg = readConfig(folder);
  const key = readKey(folder);
  if (!cfg || !key) fail(`No agent folder here. Run this inside the folder "npx binference agent-os" made.`);
  title(`Link ${cfg.name}'s wallet for a track record`);

  const status = await baw(["wallet", "status"], 10_000);
  if (status.status !== "CONNECTED") {
    fail('The Agentic Wallet is not signed in here. Start the agent and say "Sign in to Binance Agentic Wallet", then run this again.');
  }
  const addresses = await baw(["wallet", "address"]);
  const address = (addresses.addresses ?? []).find((entry) => entry.binanceChainId === "56")?.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) fail("Could not read the wallet's BNB Chain address from baw.");
  check("ok", "Agentic Wallet signed in", address);

  const settings = await baw(["wallet", "settings"]);
  if (settings.devMode?.enabled !== true) {
    check("todo", "Developer Mode is off", "signing needs it on, once");
    line(`  Turn it on in the ${SETTINGS}, run this again, and turn it off after.`);
    process.exit(1);
  }

  const challenge = await post(cfg, key, "/api/v1/cockpit/wallet/challenge", { address });
  if (challenge.status !== 200) {
    fail(challenge.json?.error?.message ?? `binference.io answered HTTP ${challenge.status}.`);
  }
  const message = JSON.stringify({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(challenge.json.typed_data)],
  });
  const preview = await baw(["sign-message", "preview", "--binanceChainId", "56", "--signType", "EIP712", "--message", message]);
  if (!preview.requestId) fail(`Binance's wallet would not prepare the signature${preview.error ? `: ${preview.error}` : "."}`);

  const shown = challenge.json.typed_data.message;
  line();
  line("  The wallet will sign this message. It sends no transaction and moves no funds:");
  line();
  line(`    ${shown.statement}`);
  line(dim(`    Agent: ${shown.agent} · Wallet: ${shown.wallet} · Domain: ${challenge.json.typed_data.domain.name}`));
  for (const risk of preview.risks ?? []) line(dim(`    Binance notes: ${risk.message ?? risk.type ?? JSON.stringify(risk)}`));
  line();
  if (!(await confirm("Sign it?", true))) fail("Nothing was signed.");

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
    fail(`The wallet did not sign${signed.error ? `: ${signed.error}` : ". Nothing was linked."}`);
  }

  const linked = await post(cfg, key, "/api/v1/cockpit/wallet/link", {
    token: challenge.json.token,
    signature: signed.signature,
    signature_recovery: signed.signatureRecovery ?? null,
  });
  if (linked.status !== 200) fail(linked.json?.error?.message ?? `binference.io answered HTTP ${linked.status}.`);
  check("ok", "Wallet linked", linked.json.wallet);
  line();
  line("  From the next session on, the agent's BNB Chain trades go to its cockpit, and each one");
  line("  is checked on chain before it counts. You choose there whether the record is public.");
  line(`  Turn Developer Mode off again now: ${SETTINGS}.`);
  line(dim(`  Cockpit: ${cfg.cockpit_url}\n`));
}
