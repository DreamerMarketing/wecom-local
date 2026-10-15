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

review.policyVersion = "operator-feedback-v3";
Object.assign(review.actions[0], {
  ownerResolution: { basis: "unknown", reason: "合成示例未确认对接运营", evidenceIds: [] },
  intent: "explicit_request", scope: "platform_operations", taskKey: "activity-cover",
  triggerEvidenceIds: ["g0001-m000001"], pendingBasis: "explicit_pending", platformBasis: "explicit_context",
  reason: "明确提出封面修改请求，尚未确认完成", platformReason: "上下文明确是小红书笔记",
});

test("unknown media and absent completion cannot supply a pending-work trigger", () => {
  for (const patch of [{ pendingBasis: "unknown_media" }, { pendingBasis: "no_completion_seen" }, { triggerEvidenceIds: [] }, { triggerEvidenceIds: ["g0002-m000001"] }, { platformBasis: "section_heading_only" }, { platformBasis: "user_correction" }]) {
    assert.throws(() => validateModelReview({ ...review, actions: [{ ...review.actions[0], ...patch }] }, manifest, contexts));
  }
  const corrected = { ...review.actions[0], platformBasis: "user_correction", feedbackRef: "synthetic-feedback:item-1", platform: "美团" };
  assert.equal(validateModelReview({ ...review, actions: [corrected] }, manifest, contexts)[0].platform, "美团");
});

test("require current policy, semantic eligibility and platform justification", () => {
  assert.throws(() => validateModelReview({ ...review, policyVersion: undefined }, manifest, contexts));
  for (const intent of ["merchant_lead_followup", "performance_report", "completed_work_report", "meeting_link", "shared_content", "standing_plan", "heading_only"]) {
    assert.throws(() => validateModelReview({ ...review, actions: [{ ...review.actions[0], intent }] }, manifest, contexts));
  }
  for (const patch of [{ scope: "merchant_reception" }, { reason: "" }, { platformReason: "" }, { taskKey: "" }]) {
    assert.throws(() => validateModelReview({ ...review, actions: [{ ...review.actions[0], ...patch }] }, manifest, contexts));
  }
});

test("merge duplicate tasks while allowing requested merchant materials and empty days", () => {
  assert.throws(() => validateModelReview({ ...review, actions: [review.actions[0], { ...review.actions[0], taskKey: " ACTIVITY-COVER " }] }, manifest, contexts));
  assert.equal(validateModelReview({ ...review, actions: [{ ...review.actions[0], scope: "merchant_material_dependency" }] }, manifest, contexts).length, 1);
  assert.deepEqual(validateModelReview({ ...review, actions: [] }, manifest, contexts), []);
});

test("model actions retain grounded evidence and explicit completion standards", () => {
  const [action] = validateModelReview(review, manifest, contexts);
  assert.equal(action.task, "修改活动笔记封面");
  assert.equal(action.completion, review.actions[0].completion);
  assert.equal(action.sender, "待确认");
  assert.equal(action.timing, "2026-01-02");
});

test("operations owners can be resolved from separate same-group context without assigning the requester", () => {
  const extended = new Map(contexts);
  extended.set("g0001", { name: "合成示例群", messages: [
    { id: "g0001-m000001", time: "2026-01-01 09:00:00", sender: "示例商家", text: "请修改活动笔记封面" },
    { id: "g0001-m000002", time: "2026-01-01 09:01:00", sender: "示例运营", text: "我负责这个平台，我来修改" },
  ] });
  for (const basis of ["accepted_commitment", "platform_operator", "explicit_assignment"]) {
    const action = { ...review.actions[0], owner: "示例运营", ownerResolution: { basis, reason: "运营明确承接同平台修改", evidenceIds: ["g0001-m000002"] } };
    assert.equal(validateModelReview({ ...review, actions: [action] }, manifest, extended)[0].sender, "示例运营");
  }
  for (const patch of [
    { owner: "未出现的人", ownerResolution: { basis: "platform_operator", reason: "错误身份", evidenceIds: ["g0001-m000002"] } },
    { owner: "示例运营", ownerResolution: { basis: "platform_operator", reason: "跨群证据", evidenceIds: ["g0002-m000001"] } },
    { owner: "示例运营", ownerResolution: { basis: "unknown", reason: "不应强填", evidenceIds: [] } },
    { ownerResolution: undefined },
  ]) assert.throws(() => validateModelReview({ ...review, actions: [{ ...review.actions[0], ...patch }] }, manifest, extended));
});

test("concise evidence quotes must exactly match same-group cited messages", () => {
  const action = { ...review.actions[0], evidenceQuotes: [{ messageId: "g0001-m000001", text: "请修改活动笔记封面" }] };
  assert.equal(validateModelReview({ ...review, actions: [action] }, manifest, contexts)[0].source, "g0001-m000001 请修改活动笔记封面");
  for (const evidenceQuotes of [[], [{ messageId: "g0001-m000001", text: "已完成" }], [{ messageId: "g0002-m000001", text: "请修改活动笔记封面" }]]) {
    assert.throws(() => validateModelReview({ ...review, actions: [{ ...action, evidenceQuotes }] }, manifest, contexts));
  }
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
  const { FileBlob, SpreadsheetFile } = await import(process.env.WECOM_ARTIFACT_TOOL);
  for (const output of delivery.outputs) {
    assert.equal(path.basename(output.outputPath), `${output.platform}运营待办事项_2026-01-01.xlsx`);
    assert.ok(!path.basename(output.outputPath).includes("简版"));
    assert.ok((await fs.stat(output.outputPath)).size > 0);
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(output.outputPath));
    assert.deepEqual(workbook.worksheets.items.map(sheet => sheet.name), ["待办清单"]);
    const sheet = workbook.worksheets.getItem("待办清单");
    assert.deepEqual(sheet.getRange("A4:E4").values[0], ["群", "负责人", "待办事项", "截止时间", "状态"]);
    assert.equal(sheet.getUsedRange().values[0].length, 5);
    assert.deepEqual(sheet.getRange("E5").dataValidation.rule.values, ["待确认", "进行中", "已完成", "阻塞"]);
    if (output.todoRows) assert.deepEqual(sheet.getRange("A5:E5").values[0], ["合成示例群", "待确认", "修改活动笔记封面", "2026-01-02", "待确认"]);
  }
  const oldDelivery = { ...delivery, workbookFormat: undefined, outputs: delivery.outputs.map(output => ({ ...output, outputPath: path.join(path.dirname(output.outputPath), `legacy-${path.basename(output.outputPath)}`), delivery: "sent" })) };
  await fs.writeFile(path.join(contextDir, "delivery.json"), JSON.stringify(oldDelivery));
  const runArgs = [fileURLToPath(new URL("./wecom_model_daily.mjs", import.meta.url)), "--date", "2026-01-01", "--actions", reviewPath];
  await promisify(execFile)(process.execPath, runArgs, { env: { ...process.env, WECOM_REPO: directory } });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(contextDir, "delivery.json"), "utf8")), JSON.parse(JSON.stringify(oldDelivery)));
  assert.equal(JSON.parse(await fs.readFile(path.join(contextDir, "preview-compact.json"), "utf8")).workbookFormat, "compact-v2");
  await assert.rejects(promisify(execFile)(process.execPath, [...runArgs, "--send"], { env: { ...process.env, WECOM_REPO: directory } }));
  const collision = { ...oldDelivery, outputs: delivery.outputs.map(output => ({ ...output, delivery: "sent" })) };
  await fs.writeFile(path.join(contextDir, "delivery.json"), JSON.stringify(collision));
  await assert.rejects(promisify(execFile)(process.execPath, runArgs, { env: { ...process.env, WECOM_REPO: directory } }));
  await fs.writeFile(path.join(contextDir, "delivery.json"), JSON.stringify(oldDelivery));
  await promisify(execFile)(process.execPath, [...runArgs, "--revision", "feedback-v2"], { env: { ...process.env, WECOM_REPO: directory } });
  const revised = JSON.parse(await fs.readFile(path.join(contextDir, "delivery-feedback-v2.json"), "utf8"));
  assert.ok(revised.outputs.every(output => output.delivery === "skipped" && output.outputPath.endsWith("_feedback-v2.xlsx")));
  assert.ok(revised.outputs.every(output => !path.basename(output.outputPath).includes("简版")));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(contextDir, "delivery.json"), "utf8")), JSON.parse(JSON.stringify(oldDelivery)));
  await assert.rejects(promisify(execFile)(process.execPath, [...runArgs, "--revision", "../escape"], { env: { ...process.env, WECOM_REPO: directory } }));
  await fs.writeFile(path.join(contextDir, "delivery.json"), JSON.stringify({ ...oldDelivery, outputs: [{ ...oldDelivery.outputs[0], delivery: "uncertain" }] }));
  await assert.rejects(promisify(execFile)(process.execPath, [...runArgs, "--revision", "another-revision"], { env: { ...process.env, WECOM_REPO: directory } }));
});
