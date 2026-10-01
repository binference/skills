#!/usr/bin/env node
// Runs detached, started by the hooks: sends the reports the outbox holds to the cockpit,
// then ends. Only one runs at a time; a second one leaves at once.

import { flushOutbox, log } from "./lib.mjs";

// Never outlives a stuck network call by much.
setTimeout(() => process.exit(0), 60_000).unref();

try {
  await flushOutbox();
} catch (error) {
  if (!String(error?.message).includes("busy")) log("flush_failed", { error: String(error?.message ?? error) });
}
process.exitCode = 0;
