import test from "node:test";
import assert from "node:assert/strict";
import { validateModelReview } from "./wecom_model_daily.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const manifest = { targetDate: "2026-01-01", failures: 0, groups: [{ id: "g0001" }, { id: "g0002" }] };
const contexts = new Map([["g0001", { name: "合成示例群", messages: [{ id: "g0001-m000001", time: "2026-01-01 09:00:00", sender: "示例运营", text: "请修改活动笔记封面" }] }], ["g0002", { name: "无任务示例群", messages: [] }]]);
const review = { targetDate: "2026-01-01", reviewedGroups: ["g0001", "g0002"], actions: [{ platform: "小红书", groupId: "g0001", task: "修改活动笔记封面", completion: "建议标准：回传新封面待确认", owner: null, dueAt: "2026-01-02", category: "内容运营", priority: "P1", status: "待确认", evidenceIds: ["g0001-m000001"] }] };

test("model actions retain grounded evidence and explicit completion standards", () => {
  const [action] = validateModelReview(review, manifest, contexts);
  assert.equal(action.task, "修改活动笔记封面");
  assert.equal(action.completion, review.actions[0].completion);
  assert.equal(action.sender, "待指派");
  assert.equal(action.timing, "2026-01-02");
});
test("fail closed on unread groups, read failures or wrong reporting date", () => {
  assert.throws(() => validateModelReview({ ...review, reviewedGroups: ["g0001"] }, manifest, contexts));
  assert.throws(() => validateModelReview(review, { ...manifest, failures: 1 }, contexts));
  assert.throws(() => validateModelReview({ ...review, targetDate: "2026-01-02" }, manifest, contexts));
});
test("reject invented evidence, cross-group evidence and completed tasks", () => {
  for (const patch of [{ evidenceIds: ["missing"] }, { groupId: "g0002" }, { status: "已完成" }, { completion: "" }]) {
    assert.throws(() => validateModelReview({ ...review, actions: [{ ...review.actions[0], ...patch }] }, manifest, contexts));
  }
});

test("reviewed actions generate three model workbooks without collection or delivery", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-model-test-"));
  const contextDir = path.join(directory, ".local/wecom-local/model-review/2026-01-01");
  await fs.mkdir(contextDir, { recursive: true });
  const groups = [];
  for (const [id, context] of contexts) {
    const file = path.join(contextDir, `${id}.json`);
    await fs.writeFile(file, JSON.stringify(context));
    groups.push({ id, file, messageCount: context.messages.length });
  }
  await fs.writeFile(path.join(contextDir, "manifest.json"), JSON.stringify({ ...manifest, groups, totalMessages: 1, totalScanned: 1 }));
  const reviewPath = path.join(contextDir, "reviewed.json");
  await fs.writeFile(reviewPath, JSON.stringify(review));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./wecom_model_daily.mjs", import.meta.url)), "--date", "2026-01-01", "--actions", reviewPath], { env: { ...process.env, WECOM_REPO: directory } });
  const delivery = JSON.parse(await fs.readFile(path.join(contextDir, "delivery.json"), "utf8"));
  assert.equal(delivery.analysisMode, "codex-model");
  assert.deepEqual(delivery.outputs.map((output) => output.todoRows), [0, 1, 0]);
  assert.deepEqual(delivery.outputs.map((output) => output.delivery), ["skipped", "skipped", "skipped"]);
  for (const output of delivery.outputs) assert.ok((await fs.stat(output.outputPath)).size > 0);
});
