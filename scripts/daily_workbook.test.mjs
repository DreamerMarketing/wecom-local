import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkbook } from "./wecom_daily_external_actions.mjs";
const { SpreadsheetFile } = await import(process.env.WECOM_ARTIFACT_TOOL);

test("platform workbooks export three sheets, editable status and distinct numbered actions", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-workbook-test-"));
  const candidate = { time: new Date("2026-01-01T09:00:00Z"), sender: "待指派（发言者：示例运营）", group: "合成示例群", timing: "今天", category: "素材管理", task: "拍摄视频1", source: "请拍摄视频1", priority: "P1", status: "待确认", messageId: "", score: 2 };
  for (const platform of ["抖音", "小红书", "美团"]) {
    const candidates = platform === "抖音" ? [candidate, { ...candidate, task: "拍摄视频2", source: "请拍摄视频2" }] : [];
    const built = buildWorkbook({ targetDate: "2026-01-01", platform, candidates, failures: [], counts: { externalGroups: 1, groupsWithMessages: 1, totalMessages: 2, totalScanned: 2, textMessages: 2 } });
    assert.equal(built.todoRows.length, candidates.length);
    assert.equal(built.workbook.worksheets.getItem("汇总").getRange("B11").values[0][0], candidates.length);
    assert.match(built.workbook.worksheets.getItem("待办清单").getRange("D2").values[0][0], new RegExp(platform));
    assert.deepEqual(built.workbook.worksheets.getItem("待办清单").getRange("J5").dataValidation.rule.values, ["待确认", "进行中", "已完成", "阻塞"]);
    await built.workbook.recalculate();
    const exported = await SpreadsheetFile.exportXlsx(built.workbook);
    await exported.save(path.join(temporary, `${platform}.xlsx`));
    for (const [sheetName, range] of [["汇总", "A1:H25"], ["待办清单", "A1:K8"], ["聊天行动明细", "A1:J8"]]) {
      const preview = await built.workbook.render({ sheetName, range, scale: 1, format: "png" });
      await fs.writeFile(path.join(temporary, `${platform}-${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
    }
  }
  console.log(`Synthetic workbook previews: ${temporary}`);
});
