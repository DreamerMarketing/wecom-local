import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { platforms } from "./daily_action_rules.mjs";
import { validateReviewPolicy } from "./daily_review_policy.mjs";
import { buildCompactWorkbook } from "./daily_compact_workbook.mjs";
import { datePartsInShanghai, shiftDate, parseDateTime, redact, messageDateInShanghai,
  runCli, ensureWeComReady, fetchHistories, sendWorkbook, readWebhookUrl } from "./wecom_daily_external_actions.mjs";

const root = process.env.WECOM_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dayDirectory = (date) => path.join(root, ".local", "wecom-local", "model-review", date);

async function atomicJson(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export function validateModelReview(review, manifest, contexts) {
  if (manifest.failures !== 0 || review.targetDate !== manifest.targetDate || !Array.isArray(review.actions)) throw new Error("Review date/collection mismatch");
  validateReviewPolicy(review);
  const expected = new Set(manifest.groups.map((group) => group.id));
  const reviewed = new Set(review.reviewedGroups);
  if (reviewed.size !== expected.size || [...expected].some((id) => !reviewed.has(id))) throw new Error("Every group must be reviewed, including groups with no tasks");
  return review.actions.map((action) => {
    const context = contexts.get(action.groupId);
    if (!context || !platforms.includes(action.platform) || !action.task?.trim() || !action.completion?.trim()
        || !["P0", "P1", "P2"].includes(action.priority)
        || !["待确认", "进行中", "阻塞"].includes(action.status)
        || !Array.isArray(action.evidenceIds) || !action.evidenceIds.length
        || action.evidenceIds.some((id) => !/^g\d{4}-m\d{6}$/.test(id))) throw new Error("Invalid reviewed action");
    const evidence = action.evidenceIds.map((id) => context.messages.find((message) => message.id === id));
    if (evidence.some((message) => !message)) throw new Error("Evidence must belong to the action's group");
    const ownerEvidence = action.ownerResolution.evidenceIds.map(id => context.messages.find(message => message.id === id));
    if (ownerEvidence.some(message => !message)) throw new Error("Owner evidence must belong to the action's group");
    if (action.owner !== null && !ownerEvidence.some(message => message.sender === action.owner || message.text.includes(`@${action.owner}`))) {
      throw new Error("Owner identity must be grounded in the cited operations context");
    }
    let source = evidence.map((message) => `${message.id} ${redact(`${message.time} ${message.sender}：${message.text}`)}`).join("；").slice(0, 1500);
    if (action.evidenceQuotes !== undefined) {
      if (!Array.isArray(action.evidenceQuotes) || !action.evidenceQuotes.length) throw new Error("Evidence quotes must not be empty");
      source = action.evidenceQuotes.map((quote) => {
        const message = evidence.find((item) => item.id === quote.messageId);
        if (!message || typeof quote.text !== "string" || !quote.text.trim() || !message.text.includes(quote.text)) throw new Error("Evidence quote must be an exact excerpt from cited evidence");
        return `${message.id} ${redact(quote.text)}`;
      }).join("；");
      if (source.length > 1000) throw new Error("Use concise evidence excerpts for readable worksheets");
    }
    return {
      platform: action.platform, time: parseDateTime(evidence[0].time), sender: redact(action.owner || "待确认"),
      group: redact(context.name), timing: redact(action.dueAt || "待确认"), category: redact(action.category || "综合运营"),
      task: redact(action.task), completion: redact(action.completion), priority: action.priority, status: action.status,
      source,
      messageId: action.evidenceIds.join(", "), score: 0,
    };
  });
}

async function prepare(date) {
  await ensureWeComReady();
  const payload = await runCli(["conversations", "--external-only"]);
  const conversations = payload.conversations || [];
  if (!conversations.length) throw new Error("No visible external groups");
  const histories = await fetchHistories(conversations, date, shiftDate(date, 1));
  const failures = histories.filter((item) => item.error).length;
  const directory = dayDirectory(date);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = { targetDate: date, collectedAt: new Date().toISOString(), failures, groups: [], totalMessages: 0, totalScanned: 0 };
  for (const [index, item] of histories.entries()) {
    const id = `g${String(index + 1).padStart(4, "0")}`;
    const name = redact(item.conversation.conversation_name);
    const messages = (item.history?.messages || []).filter((message) => !messageDateInShanghai(message) || messageDateInShanghai(message) === date)
      .sort((left, right) => String(left.send_time_text || "").localeCompare(String(right.send_time_text || "")) || Number(left.send_time || 0) - Number(right.send_time || 0))
      .map((message, offset) => ({
      id: `${id}-m${String(offset + 1).padStart(6, "0")}`,
      time: redact(message.send_time_text || "时间待确认"),
      sender: redact(message.sender_display || message.real_sender_name || message.normal_user_name || message.sender_name || "未知发送者"),
      text: redact(message.text || message.display_text || message.summary_content || message.summary_tips || "[无可读文本，无法判断媒体内容]"),
    }));
    const file = path.join(directory, `${id}.json`);
    await atomicJson(file, { groupId: id, name, targetDate: date, messages });
    manifest.groups.push({ id, name, file, messageCount: messages.length, readOk: !item.error });
    manifest.totalMessages += messages.length;
    manifest.totalScanned += Number(item.history?.scanned_count || 0);
  }
  await atomicJson(path.join(directory, "manifest.json"), manifest);
  console.log(JSON.stringify({ targetDate: date, externalGroups: conversations.length, totalMessages: manifest.totalMessages, failures, manifestPath: path.join(directory, "manifest.json") }));
  if (failures) throw new Error("Collection incomplete; model analysis/send prohibited");
}

async function renderReview(date, reviewPath, send, revision = "") {
  if (revision && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(revision)) throw new Error("Invalid revision name");
  const directory = dayDirectory(date);
  if (revision) {
    for (const file of (await fs.readdir(directory)).filter(name => /^delivery(?:-[a-z0-9-]+)?\.json$/.test(name))) {
      const ledger = JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
      if (ledger.outputs.some(output => ["sending", "uncertain"].includes(output.delivery))) throw new Error("Revision cannot bypass an uncertain delivery");
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  const contexts = new Map();
  for (const group of manifest.groups) contexts.set(group.id, JSON.parse(await fs.readFile(group.file, "utf8")));
  const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
  const actions = validateModelReview(review, manifest, contexts);
  const reviewDigest = createHash("sha256").update(JSON.stringify(review)).digest("hex");
  const deliveryPath = path.join(directory, revision ? `delivery-${revision}.json` : "delivery.json");
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(deliveryPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous?.outputs.some((output) => ["sending", "uncertain"].includes(output.delivery))) throw new Error("Prior delivery uncertain; manual review required");
  if (previous && previous.reviewDigest !== reviewDigest && previous.outputs.some((output) => output.delivery === "sent")) throw new Error("Already delivered review cannot be silently replaced");
  const format = "compact-v2";
  const priorOtherFormatSent = previous && previous.workbookFormat !== format && previous.outputs.some(output => output.delivery === "sent");
  if (send && priorOtherFormatSent) throw new Error("Prior format already sent; review compact preview before authorizing another delivery");
  const outputDir = path.join(root, "outputs", "daily-wecom-todos");
  await fs.mkdir(outputDir, { recursive: true });
  const { SpreadsheetFile } = await import(process.env.WECOM_ARTIFACT_TOOL);
  const outputs = [];
  for (const platform of platforms) {
    const candidates = actions.filter((action) => action.platform === platform);
    const built = buildCompactWorkbook({ targetDate: date, platform, candidates });
    await built.workbook.recalculate();
    await built.workbook.inspect({ kind: "table", range: `待办清单!A1:E${Math.max(5, 4 + candidates.length)}`, include: "values,formulas", tableMaxRows: 25, tableMaxCols: 5 });
    await built.workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 } });
    const outputPath = path.join(outputDir, `${platform}运营待办事项_${date}${revision ? `_${revision}` : ""}.xlsx`);
    if (previous?.workbookFormat !== format && previous?.outputs.some(output => output.delivery === "sent" && output.outputPath === outputPath)) throw new Error("Preserve previously delivered files; use an authorized named revision");
    await (await SpreadsheetFile.exportXlsx(built.workbook)).save(outputPath);
    for (const [sheetName, range, suffix] of [["待办清单", `A1:E${Math.max(5, 4 + candidates.length)}`, "compact"]]) {
      const preview = await built.workbook.render({ sheetName, range, scale: 1.2, format: "png" });
      await fs.writeFile(path.join(directory, `${platform}-${suffix}${revision ? `-${revision}` : ""}.png`), new Uint8Array(await preview.arrayBuffer()));
    }
    outputs.push({ platform, outputPath, todoRows: built.todoRows.length, delivery: "skipped" });
  }
  const state = previous?.reviewDigest === reviewDigest && previous.workbookFormat === format ? previous : { targetDate: date, reviewDigest, workbookFormat: format, analysisMode: "codex-model", failures: 0, externalGroups: manifest.groups.length, totalMessages: manifest.totalMessages, outputs };
  if (send) {
    const webhook = await readWebhookUrl();
    for (const output of state.outputs) {
      if (output.delivery === "sent") continue;
      output.delivery = "sending";
      await atomicJson(deliveryPath, state);
      try {
        await sendWorkbook(output.outputPath, webhook);
        output.delivery = "sent";
        await atomicJson(deliveryPath, state);
      } catch {
        output.delivery = "uncertain";
        await atomicJson(deliveryPath, state);
        throw new Error("Delivery failed or outcome uncertain; resend blocked");
      }
    }
  } else await atomicJson(priorOtherFormatSent ? path.join(directory, "preview-compact.json") : deliveryPath, state);
  console.log(JSON.stringify(state));
}

async function main() {
  const args = process.argv.slice(2);
  const dateIndex = args.indexOf("--date");
  const date = dateIndex >= 0 ? args[dateIndex + 1] : shiftDate(datePartsInShanghai(), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");
  if (args.includes("--prepare")) {
    if (args.includes("--send")) throw new Error("Prepare cannot send");
    await prepare(date);
  } else {
    const index = args.indexOf("--actions");
    if (index < 0 || !args[index + 1]) throw new Error("Use --prepare or --actions reviewed.json [--send]");
    const revisionIndex = args.indexOf("--revision");
    if (revisionIndex >= 0 && !args[revisionIndex + 1]) throw new Error("Revision name required");
    await renderReview(date, args[index + 1], args.includes("--send"), revisionIndex >= 0 ? args[revisionIndex + 1] : "");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error("Model workflow failed; check sanitized collection/review/delivery state."); process.exitCode = 1;
});
