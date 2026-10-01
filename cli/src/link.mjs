// Signs the CLI in to binference.io with a code the owner approves in their browser
// (RFC 8628), so no key is ever pasted into a terminal or a chat. Split in two steps,
// start and wait, so an agent can show the code and finish later (--no-wait, --resume).

import { CLI_VERSION } from "./folder.mjs";
import { CliError } from "./errors.mjs";
import { openLink } from "./system.mjs";
import { bold, check, dim, emit, line } from "./ui.mjs";

async function post(api, path, body) {
  try {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": `binference-cli/${CLI_VERSION} node/${process.versions.node}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

/** The page to approve on, only when it is on the API's own site (or a subdomain of it). */
function approvalUrl(api, raw) {
  try {
    const url = new URL(raw);
    const host = new URL(api).hostname;
    const sameSite = url.hostname === host || url.hostname.endsWith(`.${host}`);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return sameSite && (url.protocol === "https:" || (url.protocol === "http:" && local)) ? url.href : null;
  } catch {
    return null;
  }
}

/** Starts a sign-in: the code to show, and what is needed to wait for it. */
export async function startSignIn({ api, name, app }) {
  const started = await post(api, "/api/cli/links", { name, app });
  const link = started.json;
  if (started.status !== 201 || typeof link?.device_code !== "string" || typeof link.user_code !== "string") {
    throw new CliError(
      started.status === 0 ? "unreachable" : "sign_in_refused",
      started.status === 0
        ? `Could not reach ${api}.`
        : `binference.io refused the sign-in (${link?.error?.message ?? `HTTP ${started.status}`}).`,
      { hint: started.status === 0 ? "Check the connection and try again." : undefined },
    );
  }
  const url = approvalUrl(api, link.verification_uri_complete ?? link.verification_uri);
  if (!url) throw new CliError("bad_answer", `binference.io sent an approval link outside ${new URL(api).host}.`);
  return {
    device_code: link.device_code,
    user_code: link.user_code,
    url,
    // The server sets the pace; without one, RFC 8628 says five seconds.
    interval_s: Number(link.interval) >= 1 ? Number(link.interval) : 5,
    expires_at: new Date(Date.now() + (Number(link.expires_in) || 900) * 1000).toISOString(),
  };
}

/** Shows the code and the link: on the terminal, or as an `approval_required` event with --json. */
export async function showApproval(pending, { open = true } = {}) {
  emit({
    event: "approval_required",
    user_code: pending.user_code,
    url: pending.url,
    expires_at: pending.expires_at,
    say: "Ask the owner to open the url, check that the code there matches user_code, and approve with their wallet.",
  });
  line();
  line(`  Approve this agent on binference.io with your wallet. The code there must read:`);
  line();
  line(`      ${bold(pending.user_code)}`);
  line();
  // BINF_NO_BROWSER=1 for machines without one, and for tests.
  const opened = open && !process.env.BINF_NO_BROWSER ? await openLink(pending.url) : false;
  line(`  ${opened ? "Your browser is open at" : "Open"} ${pending.url}`);
  line(dim(`  Only approve a code shown in your own terminal right now.`));
  line();
}

/** A sign-in answer with what the folder needs, or null. */
function validLink(json) {
  const cockpit = json?.cockpit;
  const okKey = typeof json?.key === "string" && /^binf_[\w-]{8,256}$/.test(json.key);
  const okCockpit =
    cockpit &&
    (typeof cockpit.id === "string" || typeof cockpit.id === "number") &&
    typeof cockpit.name === "string" &&
    typeof cockpit.url === "string" &&
    /^https?:\/\//.test(cockpit.url);
  return okKey && okCockpit ? json : null;
}

/** Waits for the owner's approval: the folder's key and cockpit. */
export async function waitForApproval({ api, pending }) {
  const deadline = Date.parse(pending.expires_at);
  let interval = pending.interval_s * 1000;
  let lastNote = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resume) => setTimeout(resume, interval));
    const polled = await post(api, "/api/cli/links/token", { device_code: pending.device_code });
    if (polled.status === 200 && polled.json?.key) {
      const linked = validLink(polled.json);
      if (!linked) throw new CliError("bad_answer", "binference.io approved the agent but sent an answer this CLI cannot read.", { hint: "Update the CLI: npx binference@latest" });
      check("ok", "Approved on binference.io", linked.cockpit.url);
      emit({ event: "approved", cockpit_url: linked.cockpit.url });
      return linked;
    }
    const error = polled.json?.error;
    if (error === "authorization_pending" || polled.status === 0 || polled.status >= 500) {
      if (Date.now() - lastNote >= 30_000) {
        lastNote = Date.now();
        line(dim(`  Still waiting for approval...`));
      }
      continue;
    }
    if (error === "slow_down") {
      // RFC 8628 3.5: five seconds more, for this and every later request.
      interval += 5_000;
      continue;
    }
    throw new CliError(error === "access_denied" ? "sign_in_denied" : "sign_in_failed", polled.json?.error_description ?? `The sign-in stopped (${error ?? `HTTP ${polled.status}`}).`);
  }
  throw new CliError("sign_in_expired", "The code expired before it was approved.", { hint: "Run the setup again for a new code." });
}
