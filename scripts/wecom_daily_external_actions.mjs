import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = process.env.WECOM_REPO || path.resolve(scriptDir, "..");
const binaryPath = process.env.WECOM_LOCAL_BIN || path.join(repoDir, "target", "release", "wecom-local");
const artifactPath = process.env.WECOM_ARTIFACT_TOOL || path.join(repoDir, "node_modules", "@oai", "artifact-tool", "dist", "artifact_tool.mjs");
const outputDir = path.join(repoDir, "outputs", "daily-wecom-todos");
const runDir = path.join(repoDir, ".local", "wecom-local", "daily-runs");
const webhookFile = process.env.WECOM_WEBHOOK_FILE || path.join(repoDir, ".local", "wecom-local", "wecom-webhook.url");
const organizationLabel = String(process.env.WECOM_ORG_LABEL || "外部群").trim() || "外部群";
const organizationFileLabel = organizationLabel.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "外部群";

const { Workbook, SpreadsheetFile } = await import(artifactPath);

function parseArgs(argv) {
  const result = { date: null, send: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") result.date = argv[++i];
    else if (arg === "--send") result.send = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: run_daily_external_actions.mjs [--date YYYY-MM-DD] [--send|--dry-run]");
      process.exit(0);
    }
  }
  if (result.send && result.dryRun) throw new Error("--send and --dry-run cannot be used together");
  return result;
}

function datePartsInShanghai(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(dateText, days) {
  const value = new Date(`${dateText}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function parseDateTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  // artifact-tool writes the UTC wall-clock fields into Excel. Treat WeCom's
  // already-local timestamp as a UTC-shaped value so the displayed time is
  // not shifted backward by eight hours.
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasTimeZone ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? text : parsed;
}

function redact(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[链接已隐藏]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .replace(/1[3-9]\d{9}/g, "[手机号已隐藏]")
    .replace(/\b(?=[A-Za-z0-9_-]{8,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, "[账号标识已隐藏]")
    .replace(/\d{8,}/g, "[敏感串已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value, max = 420) {
  const text = redact(value)
    .replace(/^(大家好|早上好|各位早上好|辛苦查收|请查收)[，,:：。\s]*/i, "")
    .replace(/(有问题随时沟通|辛苦大家了|感谢大家)[。！!\s]*$/i, "")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function inferTiming(text) {
  const value = String(text ?? "");
  if (/一小时|1小时/.test(value)) return "1小时内";
  if (/明天/.test(value)) return "明天";
  if (/今天|今日/.test(value)) return "今天";
  if (/本周|这周/.test(value)) return "本周";
  if (/下周/.test(value)) return "下周";
  if (/周末/.test(value)) return "周末";
  if (/每周一|周一/.test(value)) return "每周一";
  if (/每日|每天|日常/.test(value)) return "每日";
  if (/每周|周更|周频/.test(value)) return "每周";
  if (/尽快|马上|及时|优先/.test(value)) return "尽快";
  if (/截止|到期|档期|日期|时间/.test(value)) return "按群内日期/档期执行";
  return "持续跟进";
}

const categoryRules = [
  ["投放运营", /充值|余额|消耗完|投放|广告|预算|点击|留资|CPL|人群/],
  ["客服运营", /客服|客资|加微|已读不回|私信|回复|推送|邀约|咨询/],
  ["小红书运营", /小红书/],
  ["美团\/点评\/婚礼纪", /美团|点评|婚礼纪|高德/],
  ["抖音运营", /抖音|直播|来客|脚本|配音|选品/],
  ["活动运营", /中秋|国庆|开业|活动|套餐|优惠|档期|大促/],
  ["素材管理", /素材|客片|空厅|回传|拍摄|图片|视频/],
  ["店铺口碑", /评价|差评|口碑|申诉/],
  ["后台与合规", /后台|审核|限流|合规|IP|维护/],
  ["培训与复盘", /培训|课程|复盘|数据/],
];

function inferCategory(text, sender) {
  const value = `${text} ${sender}`;
  return categoryRules.find(([, pattern]) => pattern.test(value))?.[0] || "综合运营";
}

function inferPriority(text, score) {
  const value = String(text ?? "");
  if (/余额(是|为)?0|广告.*消耗完|消耗完|一小时|限流|被限制|今天方便安排充值|尽快充值/.test(value)) return "P0";
  if (/今天|今日|明天|及时|充值|团购|活动|回传|维护|审核|后台|需要商家配合/.test(value)) return "P1";
  return score >= 3 ? "P2" : "P1";
}

function completionStandard(category) {
  if (category === "投放运营") return "计划/预算完成调整；群内回报结果";
  if (category === "客服运营") return "客资完成回复或二次触达；状态有记录";
  if (category === "素材管理") return "素材已回传、授权确认并归档";
  if (category === "活动运营") return "套餐、优惠、档期和页面入口确认并上线";
  if (category === "后台与合规") return "后台或文案完成检查；无明显合规风险";
  if (category === "培训与复盘") return "完成培训/复盘并输出调整项";
  return "完成后在群内回报；状态更新为已完成";
}

function deriveTask(text) {
  const value = compact(text);
  if (!value) return "根据群内消息完成后续跟进，并回报结果";
  if (/余额|充值|消耗完|投放|广告/.test(value)) return `核验广告余额与计划状态，完成充值/恢复/调整投放：${value}`;
  if (/客资|加微|已读不回|回复|私信/.test(value)) return `跟进客资与私信，完成回复和二次触达：${value}`;
  if (/素材|客片|空厅|回传|拍摄/.test(value)) return `收集、整理并排期使用素材：${value}`;
  return value;
}

function isBotLike(sender, text) {
  const senderText = String(sender ?? "");
  const messageText = String(text ?? "").trim();
  const automatedSender = /机器人|系统通知|群助手|小助手|留资助手|留资小助手|bot|assistant/i.test(senderText);
  const automatedLeadNotice = /前来报喜|有新的客户留资/.test(messageText)
    && /客户|电话|微信|留资时间|未提供来源/.test(messageText);
  const acknowledgementOnly = /^(收到|收到啦|已阅|好嘞|好的|OK|ok)[。！!\s]*$/.test(messageText);
  return automatedSender || automatedLeadNotice || acknowledgementOnly;
}

function messageDateInShanghai(message) {
  const timeText = String(message.send_time_text ?? "").trim();
  const dateMatch = timeText.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];
  const numericTime = Number(message.send_time);
  if (Number.isFinite(numericTime) && numericTime > 0) {
    const milliseconds = numericTime > 10_000_000_000 ? numericTime : numericTime * 1000;
    return datePartsInShanghai(new Date(milliseconds));
  }
  return null;
}

function extractCandidate(message, groupName) {
  const rawText = message.text || message.display_text || message.summary_content || message.summary_tips || "";
  const rawSender = message.sender_display || message.real_sender_name || message.normal_user_name || message.sender_name || "未标注发送者";
  const text = String(rawText).trim();
  const sender = String(rawSender).trim();
  if (!text || text.length < 8 || isBotLike(sender, text)) return null;
  const hitPatterns = [
    ["充值", /充值|余额/], ["投放", /投放|广告|预算|人群|点击|留资/], ["客服", /客服|客资|加微|私信|回复|已读不回/],
    ["内容", /小红书|抖音|脚本|直播|美团|点评|婚礼纪|视频|发布|文案/], ["素材", /素材|客片|空厅|回传|拍摄/],
    ["活动", /中秋|国庆|开业|活动|套餐|优惠|档期|大促/], ["店铺", /团购|评价|差评|页面|上架/],
    ["风控", /审核|限流|合规|后台|维护|暂停|停止/], ["计划", /本周计划|工作安排|后续工作|安排|跟进|整理|收集|优化|复盘/],
  ];
  const hits = hitPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const score = hits.length + (/(本周计划|工作安排|后续工作|请|需要|要|完成|尽快|及时)/.test(text) ? 1 : 0);
  if (score < 2) return null;
  const redactedText = redact(text);
  const redactedSender = redact(sender);
  const redactedGroup = redact(groupName);
  const category = inferCategory(text, sender);
  return {
    time: parseDateTime(message.send_time_text || message.send_time),
    sender: redactedSender,
    group: redactedGroup,
    timing: inferTiming(text),
    category,
    task: deriveTask(text),
    source: redactedText.length > 600 ? `${redactedText.slice(0, 600)}…` : redactedText,
    priority: inferPriority(text, score),
    status: "待确认",
    messageId: redact(message.message_id || message.server_id || ""),
    score,
    hits,
  };
}

function normalizeForDedup(text) {
  return String(text ?? "").replace(/\d+/g, "").replace(/\s+/g, "").slice(0, 100);
}

async function runCli(args) {
  const { stdout } = await execFileAsync("/usr/bin/sudo", ["-n", binaryPath, ...args], {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureWeComReady() {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-x", "企业微信"], { encoding: "utf8" });
  } catch {
    await execFileAsync("/usr/bin/open", ["-a", "/Applications/企业微信.app"], { encoding: "utf8" });
  }

  let lastStatus = "企业微信尚未就绪";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const doctor = await runCli(["doctor", "--json"]);
      if (doctor.status === "ready" && doctor.wecom_process?.ok) return;
      lastStatus = doctor.wecom_process?.detail || doctor.status || lastStatus;
    } catch (error) {
      const detail = String(error.stderr || error.message || error);
      if (/password is required|a terminal is required|sudo/i.test(detail)) {
        throw new Error("定时任务无法使用非交互 sudo；请先为 wecom-local 配置免密执行权限");
      }
      lastStatus = detail;
    }
    await sleep(2000);
  }
  throw new Error(`企业微信桌面端未就绪：${lastStatus}`);
}

async function fetchHistories(conversations, since, until) {
  let next = 0;
  const results = new Array(conversations.length);
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= conversations.length) return;
      const conversation = conversations[index];
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const history = await runCli([
            "history", conversation.conversation_id, "-n", "0",
            "--since", `${since} 00:00:00`, "--until", `${until} 00:00:00`, "--format", "json",
          ]);
          results[index] = { conversation, history, error: null };
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) results[index] = { conversation, history: null, error: String(lastError.message || lastError) };
    }
  }
  // The desktop Runtime bridge is not safe to attach concurrently. Sequential
  // reads are slower but avoid partial daily reports caused by competing LLDB sessions.
  await worker();
  return results;
}

function priorityRank(priority) {
  return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}

function buildWorkbook({ targetDate, histories, candidates, failures, counts }) {
  const workbook = Workbook.create();
  const summarySheet = workbook.worksheets.add("汇总");
  const todoSheet = workbook.worksheets.add("待办清单");
  const detailSheet = workbook.worksheets.add("聊天行动明细");
  const navy = "#17365D";
  const paleBlue = "#EEF5FB";
  const orange = "#FCE4D6";
  const red = "#F4CCCC";
  const green = "#E2F0D9";
  const textColor = "#1F2937";
  const border = { color: "#B7C9D6", style: "thin" };
  const todoRows = [];
  const seen = new Set();
  const sortedCandidates = [...candidates].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (b.score - a.score));
  for (const candidate of sortedCandidates) {
    const key = `${candidate.group}|${candidate.category}|${candidate.timing}|${normalizeForDedup(candidate.task)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    todoRows.push(candidate);
  }

  function baseStyle(sheet, lastCol, lastRow) {
    sheet.showGridLines = false;
    const used = sheet.getRange(`A1:${lastCol}${lastRow}`);
    used.format.font = { name: "Arial", size: 10, color: textColor };
    used.format.verticalAlignment = "center";
    used.format.wrapText = true;
  }
  function title(sheet, band, text, subtitle, address) {
    const lastCol = band.match(/:([A-Z]+)\d+$/)?.[1] || "A";
    baseStyle(sheet, lastCol, 80);
    sheet.getRange(band).format = { font: { name: "Arial", size: 16, bold: true, color: navy }, verticalAlignment: "center", wrapText: true, borders: { bottom: { color: navy, style: "thin" } } };
    sheet.getRange(address).values = [[text]];
    sheet.getRange(address).format.font = { name: "Arial", size: 16, bold: true, color: navy };
    sheet.getRange(band).format.rowHeight = 26;
    const subtitleAddress = address.replace(/2$/, "3");
    sheet.getRange(subtitleAddress).values = [[subtitle]];
    sheet.getRange(subtitleAddress).format = { font: { name: "Arial", size: 10, italic: true, color: "#52606D" }, wrapText: true };
    sheet.getRange(subtitleAddress).format.rowHeight = 18;
  }
  function header(range) {
    range.format = { fill: navy, font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: { top: border, bottom: border, left: border, right: border } };
    range.format.rowHeight = 32;
  }
  function body(sheet, range, startRow, endRow, lastCol) {
    range.format.borders = { insideHorizontal: border, bottom: border };
    range.format.verticalAlignment = "center";
    range.format.wrapText = true;
    for (let row = startRow; row <= endRow; row += 2) sheet.getRange(`A${row}:${lastCol}${row}`).format.fill = paleBlue;
  }
  function priorityColor(sheet, column, rows, index) {
    rows.forEach((row, offset) => {
      const cell = sheet.getRange(`${column}${5 + offset}`);
      const priority = row[index];
      cell.format.font = { name: "Arial", size: 10, bold: true, color: priority === "P0" ? "#9C0006" : priority === "P1" ? "#9C6500" : "#375623" };
      cell.format.fill = priority === "P0" ? red : priority === "P1" ? orange : green;
      cell.format.horizontalAlignment = "center";
    });
  }
  function asTodoRow(item, index) {
    return [index + 1, item.timing, item.timing === "持续跟进" ? "持续" : item.timing, item.sender, item.group, item.category, item.task, completionStandard(item.category), item.priority, item.status, item.source];
  }
  function asDetailRow(item) {
    return [item.time, item.sender, item.group, item.timing, item.category, item.task, item.source, item.priority, item.status, item.messageId];
  }

  title(summarySheet, "A2:H2", `${organizationLabel}运营待办总览`, `昨日数据：${targetDate}，外部群行动分析`, "A2");
  summarySheet.getRange("A4:B11").values = [
    ["数据指标", "数值"], ["外部群会话", counts.externalGroups], ["有聊天记录的群", counts.groupsWithMessages], ["昨日消息总数", counts.totalMessages],
    ["扫描消息ID", counts.totalScanned], ["文本消息", counts.textMessages], ["明确行动候选", candidates.length], ["归并待办", todoRows.length],
  ];
  header(summarySheet.getRange("A4:B4"));
  summarySheet.getRange("A5:B11").format.borders = { top: border, bottom: border, left: border, right: border };
  summarySheet.getRange("A5:A11").format.fill = paleBlue;
  summarySheet.getRange("B5:B11").format.horizontalAlignment = "center";
  summarySheet.getRange("D4:H4").values = [["优先级", "含义", "建议处理时点", "适用场景", "默认状态"]];
  header(summarySheet.getRange("D4:H4"));
  summarySheet.getRange("D5:H7").values = [["P0", "立即处理", "今天/1小时内", "余额耗尽、客资超时、限流/合规风险", "待确认"], ["P1", "近期处理", "今天至本周", "活动、团购、素材、后台、培训", "待确认"], ["P2", "例行执行", "按周/日频次", "内容更新、投放优化、素材库维护", "待确认"]];
  summarySheet.getRange("D5:H7").format.borders = { top: border, bottom: border, left: border, right: border };
  summarySheet.getRange("D5").format.fill = red;
  summarySheet.getRange("D6").format.fill = orange;
  summarySheet.getRange("D7").format.fill = green;
  summarySheet.getRange("D5:D7").format.font = { name: "Arial", size: 10, bold: true };
  summarySheet.getRange("D5:D7").format.horizontalAlignment = "center";
  const owners = new Map();
  for (const item of todoRows) {
    const stats = owners.get(item.sender) || { total: 0, p0: 0, other: 0 };
    stats.total += 1;
    if (item.priority === "P0") stats.p0 += 1; else stats.other += 1;
    owners.set(item.sender, stats);
  }
  const ownerRows = [...owners.entries()].map(([owner, stats]) => [owner, stats.total, stats.p0, stats.other]);
  summarySheet.getRange("A14:D14").values = [["负责人/运营", "待办数", "P0", "P1/P2"]];
  header(summarySheet.getRange("A14:D14"));
  if (ownerRows.length) summarySheet.getRange(`A15:D${14 + ownerRows.length}`).values = ownerRows;
  if (ownerRows.length) {
    summarySheet.getRange(`A15:D${14 + ownerRows.length}`).format.borders = { top: border, bottom: border, left: border, right: border };
    summarySheet.getRange(`A15:A${14 + ownerRows.length}`).format.fill = paleBlue;
    summarySheet.getRange(`B15:D${14 + ownerRows.length}`).format.horizontalAlignment = "center";
  }
  summarySheet.getRange("F10:H10").values = [["使用说明", "", ""]];
  summarySheet.getRange("F10:H10").format = { fill: navy, font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" } };
  summarySheet.getRange("F11:H14").values = [["待办清单", "按负责人、群、时间点、优先级筛选；状态从“待确认”开始。", ""], ["聊天行动明细", "昨日行动型消息明细；链接、邮箱、手机号和长数字已隐藏。", ""], ["口径", "负责人根据发言者与上下文推断，未明确指派的事项保留原发言者。", ""], ["采集状态", failures.length ? `有 ${failures.length} 个群读取失败，请查看本地运行日志。` : "所有外部群均已读取。", ""]];
  summarySheet.getRange("F11:H14").format.borders = { top: border, bottom: border, left: border, right: border };
  summarySheet.getRange("F11:F14").format.fill = paleBlue;
  summarySheet.getRange("F11:F14").format.font = { name: "Arial", size: 10, bold: true, color: navy };
  summarySheet.getRange("A:A").format.columnWidth = 22;
  summarySheet.getRange("B:B").format.columnWidth = 12;
  summarySheet.getRange("C:C").format.columnWidth = 4;
  summarySheet.getRange("D:D").format.columnWidth = 13;
  summarySheet.getRange("E:E").format.columnWidth = 20;
  summarySheet.getRange("F:F").format.columnWidth = 16;
  summarySheet.getRange("G:G").format.columnWidth = 44;
  summarySheet.getRange("H:H").format.columnWidth = 16;
  summarySheet.getRange("F11:H14").format.rowHeight = 38;

  const todoData = todoRows.map(asTodoRow);
  title(todoSheet, "A2:K2", `${organizationLabel}运营待办清单`, "按优先级、负责人、群和执行时间点跟进", "D2");
  todoSheet.getRange("A4:K4").values = [["编号", "执行时间点", "截止/频次", "运营/负责人", "群", "平台/类别", "待办事项", "完成标准", "优先级", "状态", "聊天依据"]];
  header(todoSheet.getRange("A4:K4"));
  if (todoData.length) todoSheet.getRange(`A5:K${4 + todoData.length}`).values = todoData;
  const todoEnd = Math.max(5, 4 + todoData.length);
  body(todoSheet, todoSheet.getRange(`A5:K${todoEnd}`), 5, todoEnd, "K");
  todoSheet.getRange(`A5:A${todoEnd}`).format.horizontalAlignment = "center";
  todoSheet.getRange(`I5:J${todoEnd}`).format.horizontalAlignment = "center";
  todoSheet.getRange(`J5:J${todoEnd}`).format.fill = "#FFF2CC";
  todoSheet.getRange(`J5:J${todoEnd}`).dataValidation = { rule: { type: "list", values: ["待确认", "进行中", "已完成", "阻塞"] } };
  if (todoData.length) priorityColor(todoSheet, "I", todoData, 8);
  todoSheet.freezePanes.freezeRows(4);
  todoSheet.tables.add(`A4:K${todoEnd}`, true, "DailyTodoTable");
  todoSheet.getRange("A:A").format.columnWidth = 7;
  todoSheet.getRange("B:B").format.columnWidth = 22;
  todoSheet.getRange("C:C").format.columnWidth = 17;
  todoSheet.getRange("D:D").format.columnWidth = 24;
  todoSheet.getRange("E:E").format.columnWidth = 36;
  todoSheet.getRange("F:F").format.columnWidth = 17;
  todoSheet.getRange("G:G").format.columnWidth = 58;
  todoSheet.getRange("H:H").format.columnWidth = 34;
  todoSheet.getRange("I:I").format.columnWidth = 9;
  todoSheet.getRange("J:J").format.columnWidth = 11;
  todoSheet.getRange("K:K").format.columnWidth = 30;
  todoSheet.getRange(`A5:K${todoEnd}`).format.rowHeight = 42;

  const detailData = candidates.map(asDetailRow);
  title(detailSheet, "A2:J2", "聊天行动明细", "保留昨日识别出的行动型消息，内容已脱敏", "F2");
  detailSheet.getRange("A4:J4").values = [["聊天时间", "运营/负责人", "群", "执行时间点", "平台/类别", "待办事项", "原始聊天要点（已脱敏）", "优先级", "状态", "消息ID"]];
  header(detailSheet.getRange("A4:J4"));
  if (detailData.length) detailSheet.getRange(`A5:J${4 + detailData.length}`).values = detailData;
  const detailEnd = Math.max(5, 4 + detailData.length);
  body(detailSheet, detailSheet.getRange(`A5:J${detailEnd}`), 5, detailEnd, "J");
  detailSheet.getRange(`A5:A${detailEnd}`).format.numberFormat = "yyyy-mm-dd hh:mm";
  detailSheet.getRange(`A5:A${detailEnd}`).format.horizontalAlignment = "center";
  detailSheet.getRange(`H5:I${detailEnd}`).format.horizontalAlignment = "center";
  detailSheet.getRange(`I5:I${detailEnd}`).format.fill = "#FFF2CC";
  detailSheet.getRange(`I5:I${detailEnd}`).dataValidation = { rule: { type: "list", values: ["待确认", "进行中", "已完成", "阻塞"] } };
  if (detailData.length) priorityColor(detailSheet, "H", detailData, 7);
  detailSheet.freezePanes.freezeRows(4);
  detailSheet.tables.add(`A4:J${detailEnd}`, true, "DailyActionDetailTable");
  detailSheet.getRange("A:A").format.columnWidth = 19;
  detailSheet.getRange("B:B").format.columnWidth = 24;
  detailSheet.getRange("C:C").format.columnWidth = 34;
  detailSheet.getRange("D:D").format.columnWidth = 22;
  detailSheet.getRange("E:E").format.columnWidth = 18;
  detailSheet.getRange("F:F").format.columnWidth = 62;
  detailSheet.getRange("G:G").format.columnWidth = 64;
  detailSheet.getRange("H:H").format.columnWidth = 9;
  detailSheet.getRange("I:I").format.columnWidth = 11;
  detailSheet.getRange("J:J").format.columnWidth = 18;
  detailSheet.getRange(`A5:J${detailEnd}`).format.rowHeight = 54;

  return { workbook, todoRows, detailRows: candidates, ownerCount: ownerRows.length };
}

async function sendWorkbook(filePath, webhookUrl) {
  const base = new URL(webhookUrl);
  base.pathname = "/cgi-bin/webhook/upload_media";
  base.search = `?key=${encodeURIComponent(new URL(webhookUrl).searchParams.get("key") || "")}&type=file`;
  const form = new FormData();
  form.append("media", new Blob([await fs.readFile(filePath)]), path.basename(filePath));
  const uploadResponse = await fetch(base, { method: "POST", body: form });
  const upload = await uploadResponse.json();
  if (!uploadResponse.ok || upload.errcode !== 0 || !upload.media_id) throw new Error(`企业微信文件上传失败（错误码 ${upload.errcode ?? "unknown"}）`);
  const sendResponse = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgtype: "file", file: { media_id: upload.media_id } }) });
  const sent = await sendResponse.json();
  if (!sendResponse.ok || sent.errcode !== 0) throw new Error(`企业微信文件发送失败（错误码 ${sent.errcode ?? "unknown"}）`);
  return { ok: true };
}

async function readWebhookUrl() {
  if (process.env.WECOM_WEBHOOK_URL) return process.env.WECOM_WEBHOOK_URL.trim();
  return (await fs.readFile(webhookFile, "utf8")).trim();
}

const args = parseArgs(process.argv.slice(2));
const today = datePartsInShanghai();
const targetDate = args.date || shiftDate(today, -1);
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error(`无效日期：${targetDate}`);
const until = shiftDate(targetDate, 1);
await ensureWeComReady();
const conversationsPayload = await runCli(["conversations", "--external-only"]);
const conversations = conversationsPayload.conversations || [];
const historyResults = await fetchHistories(conversations, targetDate, until);
const failures = historyResults.filter((item) => item.error).map((item) => ({ group: redact(item.conversation?.conversation_name), conversationId: redact(item.conversation?.conversation_id), error: "读取失败" }));
const messages = historyResults
  .flatMap((item) => (item.history?.messages || []).map((message) => ({
    ...message,
    __group: item.conversation.conversation_name,
    __conversationId: item.conversation.conversation_id,
  })))
  .filter((message) => {
    const messageDate = messageDateInShanghai(message);
    return !messageDate || messageDate === targetDate;
  });
const textMessages = messages.filter((message) => String(message.text || message.display_text || message.summary_content || "").trim()).length;
const candidates = messages.map((message) => extractCandidate(message, message.__group)).filter(Boolean);
const counts = {
  externalGroups: conversations.length,
  groupsWithMessages: new Set(messages.map((message) => message.__conversationId)).size,
  totalMessages: messages.length,
  totalScanned: historyResults.reduce((sum, item) => sum + Number(item.history?.scanned_count || 0), 0),
  textMessages,
};
const built = buildWorkbook({ targetDate, histories: historyResults, candidates, failures, counts });
await built.workbook.recalculate();
await built.workbook.inspect({ kind: "table", range: "汇总!A1:H25", include: "values,formulas", table_max_rows: 25, table_max_cols: 8 });
await built.workbook.inspect({ kind: "table", range: "待办清单!A1:K12", include: "values,formulas", table_max_rows: 12, table_max_cols: 11 });
await built.workbook.inspect({ kind: "match", search_term: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { use_regex: true, max_results: 100 }, summary: "daily formula error scan" });
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(runDir, { recursive: true });
const outputPath = path.join(outputDir, `${organizationFileLabel}运营待办事项_${targetDate}.xlsx`);
const exported = await SpreadsheetFile.exportXlsx(built.workbook);
await exported.save(outputPath);
const previewDir = path.join(runDir, targetDate);
await fs.mkdir(previewDir, { recursive: true });
for (const [sheetName, range, fileName] of [["汇总", "A1:H25", "summary.png"], ["待办清单", "A1:K22", "todo.png"], ["聊天行动明细", "A1:J18", "detail.png"]]) {
  const image = await built.workbook.render({ sheetName, range, scale: 1.2, format: "png" });
  await fs.writeFile(path.join(previewDir, fileName), new Uint8Array(await image.arrayBuffer()));
}
let delivery = { ok: false, skipped: true };
let deliveryError = null;
if (args.send) {
  try {
    delivery = await sendWorkbook(outputPath, await readWebhookUrl());
  } catch (error) {
    delivery = { ok: false, skipped: false };
    deliveryError = error;
  }
}
const runSummary = { targetDate, outputPath, externalGroups: counts.externalGroups, groupsWithMessages: counts.groupsWithMessages, totalMessages: counts.totalMessages, textMessages: counts.textMessages, candidates: candidates.length, todoRows: built.todoRows.length, failures: failures.length, delivery: delivery.ok ? "sent" : delivery.skipped ? "skipped" : "failed" };
await fs.writeFile(path.join(runDir, `${targetDate}.json`), JSON.stringify(runSummary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(runSummary));
if (deliveryError) throw deliveryError;
