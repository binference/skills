#!/usr/bin/env node
// Stop: a turn ended. Tells the cockpit the agent is alive (its "idle since"), and sends
// any reports the outbox still holds.

import { answer, api, config, flushOutbox, input } from "./lib.mjs";

const hook = await input();
if (!config()) answer();
const sessionId =
  typeof hook.session_id === "string" && /^[\w.:-]{1,128}$/.test(hook.session_id)
    ? hook.session_id
    : null;
if (sessionId) await api("POST", "/api/v1/cockpit/turns", { app_session_id: sessionId }, 3_000);
await flushOutbox(sessionId);
answer();
