// The cockpit's limits (binference.io/account/cockpit), applied before an action runs. Pure:
// the hooks fetch the rules and value the action, and this decides.
//
// allow    run it
// deny     refuse it, with the reason the model and the person read
// ask      Claude Code asks the person in its own prompt
// confirm  Codex cannot ask from a hook, so the person types a code instead (prompt.mjs)

import { tokenKey } from "./commands.mjs";

/** Actions that move value: the rules about dollars apply to them. */
export const VALUE_ACTIONS = new Set([
  "swap",
  "limit_order",
  "send",
  "defi",
  "prediction",
  "contract_call",
  "x402_payment",
  "exchange_order",
]);

/** Whether the dollar rules apply to a write: a value action, or one marked as moving value. */
export function movesValue(write) {
  return VALUE_ACTIONS.has(write.action) || write.moves_value === true;
}

export function dollars(value) {
  return `$${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const NEVER_AROUND = "Do not split it or try another way; tell the person.";

function amount(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether `write` may run.
 *
 * state      the cockpit as GET /api/v1/cockpit answers it (rules, paused, traded today)
 * write      { action, from_token, to_token, moves_value?, unparsed? }
 * usd        the action's dollar value, or null when it could not be told
 * extraToday dollars traded today that the server has not counted yet
 * app        "claude_code" or "codex"
 * confirmed  the person already confirmed this exact command (Codex)
 */
export function decide({ state, write, usd, extraToday = 0, app, confirmed = false }) {
  if (state?.paused || state?.stopped) {
    return {
      decision: "deny",
      rule: "paused",
      reason:
        "This agent's owner paused it on binference.io. Do not trade. Tell the person to resume it from the agent's cockpit there.",
    };
  }
  const rules = state?.rules ?? {};
  const ask = (rule, reason) =>
    confirmed
      ? { decision: "allow", rule: null, reason: null }
      : { decision: app === "codex" ? "confirm" : "ask", rule, reason };

  // A call the hooks could not read can do anything: with any limit set, the person decides.
  const anyRule =
    rules.max_trade_usd || rules.day_trade_usd || rules.confirm_above_usd || Array.isArray(rules.allowed_tokens);
  if (write.unparsed && anyRule) {
    return ask(
      "confirm",
      `bInference could not read what this command does (${write.command}), so your limits on binference.io cannot be checked. The person has to confirm it. ${NEVER_AROUND}`,
    );
  }

  const allowed = Array.isArray(rules.allowed_tokens)
    ? new Set(rules.allowed_tokens.map(tokenKey))
    : null;
  if (allowed) {
    const tokens = [write.from_token, write.to_token].filter(Boolean).map(tokenKey);
    const outside = tokens.find((token) => !allowed.has(token));
    if (outside) {
      return {
        decision: "deny",
        rule: "token",
        reason: `Your limits on binference.io allow only the tokens listed there, and ${outside} is not one. ${NEVER_AROUND}`,
      };
    }
  }

  if (!movesValue(write)) return { decision: "allow", rule: null, reason: null };

  const maxTrade = amount(rules.max_trade_usd);
  const dayTrade = amount(rules.day_trade_usd);
  const confirmAbove = amount(rules.confirm_above_usd);
  const ruled = maxTrade !== null || dayTrade !== null || confirmAbove !== null;
  if (!ruled) return { decision: "allow", rule: null, reason: null };

  if (usd === null) {
    return ask(
      "confirm",
      "Your limits on binference.io cap trades by dollar value, and this action's value could not be told. The person has to confirm it.",
    );
  }
  if (maxTrade !== null && usd > maxTrade) {
    return {
      decision: "deny",
      rule: "max_trade",
      reason: `This is worth about ${dollars(usd)}, over the ${dollars(maxTrade)} a trade your limits on binference.io allow. ${NEVER_AROUND}`,
    };
  }
  const today = (amount(state?.traded_today_usd) ?? 0) + extraToday;
  if (dayTrade !== null && today + usd > dayTrade) {
    return {
      decision: "deny",
      rule: "day_trade",
      reason: `This would take today's trading to about ${dollars(today + usd)}, over the ${dollars(dayTrade)} a day your limits on binference.io allow. ${NEVER_AROUND}`,
    };
  }
  if (confirmAbove !== null && usd > confirmAbove) {
    return ask(
      "confirm",
      `This is worth about ${dollars(usd)}, above the ${dollars(confirmAbove)} your limits on binference.io ask the person to confirm.`,
    );
  }
  return { decision: "allow", rule: null, reason: null };
}
