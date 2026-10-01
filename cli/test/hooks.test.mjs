// The hooks as the apps run them: real processes, JSON on stdin, against a fake `baw` and
// stub servers. Each test is one way the limits used to fail.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { bash, fakeBin, hangingServer, makeAgent, readState, runHook, stubServer, swap, until, USDT } from "./helpers.mjs";

const now = () => Date.now();
const cached = (cockpit, ageMs = 0) => ({ cockpit, cockpit_at: now() - ageMs });
const outboxLines = (folder) => {
  const path = join(folder, ".binference", "outbox.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

describe("pre-tool", () => {
  it("refuses at once when the site hangs, whatever the outbox holds", async () => {
    const site = await hangingServer();
    const backlog = Array.from({ length: 500 }, (_, i) => ({ ref: `r${i}`, action: "swap", status: "submitted" }));
    // The owner paused the agent; the copy here is two minutes old, so the site is asked first.
    const folder = makeAgent({ api: site.url, state: cached({ paused: true, rules: {} }, 120_000), outbox: backlog });
    const result = await runHook(folder, "pre-tool.mjs", bash(swap()));
    site.close();
    assert.equal(result.decision, "deny");
    assert.ok(result.ms < 10_000, `answered after ${result.ms} ms`);
  });

  it("counts trades checked at the same time against each other", async () => {
    const bin = fakeBin();
    const env = { FAKE_QUOTE: "60", FAKE_DELAY: "1" };
    const folder = makeAgent({ state: cached({ paused: false, traded_today_usd: "0", rules: { day_trade_usd: "100" } }) });
    const results = await Promise.all([
      runHook(folder, "pre-tool.mjs", bash(swap(), "toolu_01RACE00001"), { env, bin }),
      runHook(folder, "pre-tool.mjs", bash(swap(), "toolu_01RACE00002"), { env, bin }),
    ]);
    assert.deepEqual(results.map((result) => result.decision).sort(), ["allow", "deny"]);
    assert.equal(readState(folder).today.usd, 60);
  });

  it("does not trust a copy of the cockpit dated in the future", async () => {
    const site = await stubServer({ "GET /api/v1/cockpit": [200, { paused: true, rules: {} }] });
    const folder = makeAgent({ api: site.url, state: { cockpit: { rules: {} }, cockpit_at: 9_999_999_999_999 } });
    const result = await runHook(folder, "pre-tool.mjs", bash(swap()));
    site.close();
    assert.equal(result.decision, "deny");
  });

  it("refuses shell commands that touch the folder's limits or key", async () => {
    const folder = makeAgent();
    for (const command of [`echo '{}' > .binference/state.json`, "cat .binference/key", "rm -rf .binference/hooks"]) {
      const result = await runHook(folder, "pre-tool.mjs", bash(command));
      assert.equal(result.decision, "deny", command);
    }
    assert.equal((await runHook(folder, "pre-tool.mjs", bash("ls -la && git status"))).decision, "allow");
  });

  it("finds trades however they are run, and asks about wallet calls it cannot read", async () => {
    const folder = makeAgent({ state: cached({ rules: { max_trade_usd: "10" } }) });
    const env = { FAKE_QUOTE: "60" };
    for (const command of [`bash -c "${swap()}"`, `(${swap()})`, `echo $(${swap()})`, `timeout 60 ${swap()}`, `echo 1 | xargs ${swap()}`]) {
      assert.equal((await runHook(folder, "pre-tool.mjs", bash(command), { env })).decision, "deny", command);
    }
    const unread = await runHook(folder, "pre-tool.mjs", bash(`echo "${swap()}" | sh`));
    assert.equal(unread.decision, "ask");
  });

  it("asks the person when the check cannot finish, instead of letting the trade through", async () => {
    // Another process holds the state's lock and never lets go: the check cannot complete.
    const folder = makeAgent({ state: cached({ rules: { max_trade_usd: "100" } }) });
    writeFileSync(join(folder, ".binference", "state.lock"), String(process.pid));
    const result = await runHook(folder, "pre-tool.mjs", bash(swap()), { env: { FAKE_QUOTE: "60" } });
    assert.equal(result.decision, "ask");
    assert.ok(result.ms < 25_000, `answered after ${result.ms} ms`);
  });

  it("sends refusals to the cockpit in the background", async () => {
    const site = await stubServer({ "POST /api/v1/cockpit/events": [200, {}] });
    const folder = makeAgent({ api: site.url, state: cached({ paused: true, rules: {} }) });
    const result = await runHook(folder, "pre-tool.mjs", bash(swap()));
    assert.equal(result.decision, "deny");
    assert.ok(await until(() => site.requests.some((request) => request.key === "POST /api/v1/cockpit/events")));
    assert.ok(await until(() => outboxLines(folder).length === 0), "the outbox is emptied once sent");
    site.close();
    assert.equal(site.requests.find((request) => request.key === "POST /api/v1/cockpit/events").body.events[0].status, "blocked");
  });
});

describe("Codex confirmations", () => {
  it("unlocks a trade above the confirm line once, with the code the person types", async () => {
    const folder = makeAgent({ app: "codex", state: cached({ rules: { confirm_above_usd: "10" } }) });
    const trade = { ...bash(swap("20", USDT, "0x0000000000000000000000000000000000000001")), turn_id: "t1" };
    const first = await runHook(folder, "pre-tool.mjs", trade);
    assert.equal(first.decision, "deny");
    const code = /confirm (\d{4})/.exec(first.json.hookSpecificOutput.permissionDecisionReason)?.[1];
    assert.ok(code);
    const typed = await runHook(folder, "prompt.mjs", { prompt: `confirm ${code}` });
    assert.match(typed.json.hookSpecificOutput.additionalContext, /confirmed/);
    assert.equal((await runHook(folder, "pre-tool.mjs", trade)).decision, "allow");
    assert.equal((await runHook(folder, "pre-tool.mjs", trade)).decision, "deny", "a confirmation works once");
  });
});

describe("post-tool", () => {
  it("records a trade even when its output is cut off", async () => {
    const folder = makeAgent({ api: "http://127.0.0.1:9" });
    const result = await runHook(folder, "post-tool.mjs", {
      ...bash(swap()),
      hook_event_name: "PostToolUse",
      tool_response: { stdout: '{"success":true,"data":{"orderId":"123"' },
    });
    assert.equal(result.code, 0);
    assert.ok(result.ms < 5_000);
    assert.equal(outboxLines(folder)[0].event.action, "swap");
  });
});

describe("session-start", () => {
  it("answers within its budget when the site hangs, and records that it ran", async () => {
    const site = await hangingServer();
    const folder = makeAgent({ api: site.url, state: cached({ paused: true, rules: {}, cockpit: { name: "test", url: "x" } }, 120_000) });
    const result = await runHook(folder, "session-start.mjs", { session_id: "s1", hook_event_name: "SessionStart", source: "startup" });
    site.close();
    assert.ok(result.ms < 15_000, `answered after ${result.ms} ms`);
    assert.match(result.json.hookSpecificOutput.additionalContext, /PAUSED/);
    assert.ok(readState(folder).last_session.at);
  });
});
