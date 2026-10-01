#!/usr/bin/env node
// UserPromptSubmit, for Codex: a hook there can refuse a command but not ask the person,
// so a trade above the confirm line waits for the person to type "confirm 1234". Only the
// person types prompts, so the model cannot confirm its own trade. The prompt itself is
// read for that pattern alone and never kept or sent.

import { answer, input, readState, writeState } from "./lib.mjs";

const hook = await input();
const typed = /^\s*confirm\s+(\d{4})\s*\.?\s*$/i.exec(typeof hook.prompt === "string" ? hook.prompt : "");
if (!typed) answer();

const local = readState();
const now = Date.now();
const pending = (local.pending_confirms ?? []).filter((entry) => entry.expires > now);
const match = pending.find((entry) => entry.code === typed[1]);
if (!match) {
  answer({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "That confirmation code does not match a waiting trade, or it expired. Nothing was confirmed.",
    },
  });
}

writeState({
  ...local,
  pending_confirms: pending.filter((entry) => entry !== match),
  confirmed: [...(local.confirmed ?? []).filter((entry) => entry.expires > now), { hash: match.hash, expires: now + 10 * 60_000 }].slice(-10),
});
answer({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `The person confirmed the waiting trade with code ${match.code}. Run that exact command again now; it works once, within 10 minutes.`,
  },
});
