// Signs the CLI in to binference.io with a code the owner approves in their browser
// (RFC 8628), so no key is ever pasted into a terminal or a chat.

import { bold, check, dim, fail, line } from "./ui.mjs";
import { openLink } from "./system.mjs";

async function post(api, path, body) {
  try {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON.
    }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, json: null, error };
  }
}

/** The folder's key and cockpit, once the owner approves the code on /link. */
export async function signIn({ api, name, app }) {
  const started = await post(api, "/api/cli/links", { name, app });
  if (started.status !== 201 || !started.json?.device_code) {
    fail(
      started.status === 0
        ? `Could not reach ${api}. Check your connection and try again.`
        : `binference.io refused the sign-in (${started.json?.error?.message ?? `HTTP ${started.status}`}).`,
    );
  }
  const link = started.json;
  line();
  line(`  Approve this agent on binference.io with your wallet. The code there must read:`);
  line();
  line(`      ${bold(link.user_code)}`);
  line();
  // BINF_NO_BROWSER=1 for machines without one, and for tests.
  const opened = process.env.BINF_NO_BROWSER ? false : await openLink(link.verification_uri_complete);
  line(`  ${opened ? "Your browser is open at" : "Open"} ${link.verification_uri_complete}`);
  line(dim(`  Only approve a code shown in your own terminal right now.`));
  line();

  const deadline = Date.now() + link.expires_in * 1000;
  let interval = Math.max(2, link.interval ?? 3) * 1000;
  let waited = 0;
  while (Date.now() < deadline) {
    await new Promise((resume) => setTimeout(resume, interval));
    waited += interval;
    const polled = await post(api, "/api/cli/links/token", { device_code: link.device_code });
    if (polled.status === 200 && polled.json?.key) {
      check("ok", "Approved on binference.io", polled.json.cockpit?.url);
      return polled.json;
    }
    const error = polled.json?.error;
    if (error === "authorization_pending" || polled.status === 0 || polled.status >= 500) {
      if (waited % 30_000 < interval) line(dim(`  Still waiting for approval...`));
      continue;
    }
    if (error === "slow_down") {
      interval += 2_000;
      continue;
    }
    fail(polled.json?.error_description ?? `The sign-in stopped (${error ?? `HTTP ${polled.status}`}).`);
  }
  fail("The code expired before it was approved. Run the setup again for a new one.");
}
