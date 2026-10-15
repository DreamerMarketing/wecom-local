import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platforms } from "./daily_action_rules.mjs";

const execFileAsync = promisify(execFile);
const repoDir = process.env.WECOM_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function scheduleDecision(now, state) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const targetDate = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  if (Number(parts.hour) < 8) return { targetDate, action: "before-08:00" };
  if (state?.targetDate === targetDate) {
    if (state.outputs?.some((output) => ["sending", "uncertain"].includes(output.delivery))) return { targetDate, action: "delivery-needs-review" };
    if (state.failures === 0 && platforms.every((platform) => state.outputs?.filter((output) => output.platform === platform && output.delivery === "sent").length === 1)) return { targetDate, action: "already-sent" };
  }
  return { targetDate, action: "run" };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function saveState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function runScheduled({ directory = repoDir, now = new Date(), collect, sender, webhookReader } = {}) {
  const runDir = path.join(directory, ".local", "wecom-local", "daily-runs");
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const lock = path.join(runDir, "scheduler.lock");
  let owner;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      owner = await fs.open(lock, "wx", 0o600);
      await owner.writeFile(String(process.pid));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await fs.readFile(lock, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid scheduler lock; manual review required");
      try { process.kill(pid, 0); console.log("Scheduler already running; skipped"); return; }
      catch (probe) { if (probe.code !== "ESRCH") throw probe; }
      await fs.unlink(lock);
    }
  }
  if (!owner) throw new Error("Unable to acquire scheduler lock");
  try {
    const initial = scheduleDecision(now, null);
    const statePath = path.join(runDir, `${initial.targetDate}.scheduler.json`);
    const summaryPath = path.join(runDir, `${initial.targetDate}.json`);
    let state = await readJson(statePath);
    if (!state) {
      const existing = await readJson(summaryPath);
      if (scheduleDecision(now, existing).action === "already-sent") state = existing;
    }
    const decision = scheduleDecision(now, state);
    console.log(JSON.stringify(decision));
    if (decision.action === "delivery-needs-review") throw new Error("Prior delivery outcome is uncertain; automatic resend blocked");
    if (decision.action !== "run") return;
    if (!state) {
      const { stdout } = collect ? await collect(decision.targetDate) : await execFileAsync("/bin/bash", [path.join(directory, "scripts/run-wecom-daily-external-actions.sh"), "--date", decision.targetDate, "--dry-run"], {
        cwd: directory, env: process.env, maxBuffer: 8 * 1024 * 1024,
      });
      // The collector prints only sanitized statistics and artifact locations.
      console.log(stdout.trim());
      state = await readJson(summaryPath);
      if (state?.targetDate !== decision.targetDate || state.failures !== 0 || !platforms.every((platform) => state.outputs?.filter((output) => output.platform === platform).length === 1)) {
        throw new Error("Collection incomplete; no files sent");
      }
      await saveState(statePath, state);
    }
    if (state.failures !== 0) throw new Error("Collection failures prohibit sending");
    const api = sender && webhookReader ? null : await import("./wecom_daily_external_actions.mjs");
    const sendWorkbook = sender || api.sendWorkbook;
    const webhook = await (webhookReader || api.readWebhookUrl)();
    for (const output of state.outputs) {
      if (output.delivery === "sent") continue;
      await fs.access(output.outputPath);
      output.delivery = "sending";
      await saveState(statePath, state);
      try {
        await sendWorkbook(output.outputPath, webhook);
        output.delivery = "sent";
        await saveState(statePath, state);
        await saveState(summaryPath, state);
      } catch {
        output.delivery = "uncertain";
        await saveState(statePath, state);
        throw new Error("Robot upload/send failed or outcome uncertain; automatic resend blocked");
      }
    }
    state.completedAt = new Date().toISOString();
    await saveState(statePath, state);
    await saveState(summaryPath, state);
    console.log(JSON.stringify({ targetDate: state.targetDate, failures: state.failures, outputs: state.outputs.map(({ platform, todoRows, delivery }) => ({ platform, todoRows, delivery })) }));
  } finally {
    await owner.close();
    await fs.unlink(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runScheduled().catch(() => {
    console.error("Scheduled WeCom job failed; check collection state or uncertain delivery before retrying.");
    process.exitCode = 1;
  });
}
