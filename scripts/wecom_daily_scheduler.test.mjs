import test from "node:test";
import assert from "node:assert/strict";
import { scheduleDecision, runScheduled } from "./wecom_daily_scheduler.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Shanghai 08:00 gate and late login catch-up", () => {
  assert.deepEqual(scheduleDecision(new Date("2026-10-15T07:59:59+08:00")), { targetDate: "2026-10-14", action: "before-08:00" });
  assert.equal(scheduleDecision(new Date("2026-10-15T08:00:00+08:00")).action, "run");
  assert.equal(scheduleDecision(new Date("2026-10-15T09:14:00+08:00")).action, "run");
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-schedule-test-"));
  const runDir = path.join(directory, ".local/wecom-local/daily-runs");
  await fs.mkdir(runDir, { recursive: true });
  const state = { targetDate: "2026-10-14", failures: 0, outputs: [] };
  for (const platform of ["抖音", "小红书", "美团"]) {
    const outputPath = path.join(directory, `${platform}.xlsx`);
    await fs.writeFile(outputPath, "synthetic fixture");
    state.outputs.push({ platform, outputPath, delivery: "skipped" });
  }
  const summaryPath = path.join(runDir, "2026-10-14.json");
  const options = { directory, now: new Date("2026-10-15T10:00:00+08:00"), webhookReader: async () => "synthetic", collect: async () => {
    await fs.writeFile(summaryPath, JSON.stringify(state));
    return { stdout: "synthetic collection" };
  } };
  return { options, runDir, state };
}

test("late-login run sends each platform once and subsequent checks skip", async () => {
  const { options } = await fixture();
  let sends = 0;
  const sender = async () => { sends += 1; };
  await runScheduled({ ...options, sender });
  await runScheduled({ ...options, sender });
  assert.equal(sends, 3);
});

test("interrupted delivery preserves sent files and blocks automatic duplicate retry", async () => {
  const { options, runDir } = await fixture();
  let sends = 0;
  const sender = async () => { sends += 1; if (sends === 2) throw new Error("synthetic network failure"); };
  await assert.rejects(runScheduled({ ...options, sender }));
  const state = JSON.parse(await fs.readFile(path.join(runDir, "2026-10-14.scheduler.json"), "utf8"));
  assert.deepEqual(state.outputs.map((output) => output.delivery), ["sent", "uncertain", "skipped"]);
  await assert.rejects(runScheduled({ ...options, sender }));
  assert.equal(sends, 2);
});

test("collection failures send nothing and can retry later", async () => {
  const { options, state } = await fixture();
  state.failures = 1;
  let sends = 0;
  const sender = async () => { sends += 1; };
  await assert.rejects(runScheduled({ ...options, sender }));
  assert.equal(sends, 0);
  state.failures = 0;
  await runScheduled({ ...options, sender });
  assert.equal(sends, 3);
});

test("a concurrent invocation skips while the original holds the process lock", async () => {
  const { options } = await fixture();
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const sender = async () => {
    sends += 1;
    if (sends === 1) { entered(); await gate; }
  };
  const original = runScheduled({ ...options, sender });
  await ready;
  await runScheduled({ ...options, sender });
  assert.equal(sends, 1);
  release();
  await original;
  assert.equal(sends, 3);
});
test("skip only complete zero-failure delivery for the target day", () => {
  const now = new Date("2026-10-15T10:00:00+08:00");
  const state = { targetDate: "2026-10-14", failures: 0, outputs: ["抖音", "小红书", "美团"].map((platform) => ({ platform, delivery: "sent" })) };
  assert.equal(scheduleDecision(now, state).action, "already-sent");
  assert.equal(scheduleDecision(now, { ...state, targetDate: "2026-10-13" }).action, "run");
  assert.equal(scheduleDecision(now, { ...state, outputs: state.outputs.slice(0, 2) }).action, "run");
  assert.equal(scheduleDecision(now, { ...state, failures: 1 }).action, "run");
});
test("uncertain or interrupted delivery requires review instead of duplicate sending", () => {
  for (const delivery of ["sending", "uncertain"]) {
    assert.equal(scheduleDecision(new Date("2026-10-15T10:00:00+08:00"), { targetDate: "2026-10-14", outputs: [{ platform: "抖音", delivery }] }).action, "delivery-needs-review");
  }
});
