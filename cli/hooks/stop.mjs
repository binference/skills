#!/usr/bin/env node
// Stop: a turn ended. Tells the cockpit the agent is alive (its "idle since"), and starts
// sending any reports the outbox still holds.

import { answer, api, config, flushInBackground, input } from "./lib.mjs";

const hook = await input();
if (!config()) await answer();
const sessionId =
  typeof hook.session_id === "string" && /^[\w.:-]{1,128}$/.test(hook.session_id) ? hook.session_id : null;
flushInBackground();
if (sessionId) await api("POST", "/api/v1/cockpit/turns", { app_session_id: sessionId }, 3_000);
await answer();
