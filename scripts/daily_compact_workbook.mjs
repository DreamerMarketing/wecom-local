const { Workbook } = await import(process.env.WECOM_ARTIFACT_TOOL);

export function buildCompactWorkbook({ platform, targetDate, candidates }) {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("待办清单");
  sheet.showGridLines = false;
  const rank = { P0: 0, P1: 1, P2: 2 };
  const todoRows = [...candidates].sort((a, b) => rank[a.priority] - rank[b.priority]);
  const end = Math.max(5, todoRows.length + 4);
  sheet.getRange(`A1:E${end}`).format = { font: { name: "Arial", size: 11, color: "#1F2937" }, verticalAlignment: "top", wrapText: true };
  sheet.getRange("A2").values = [[`${platform}运营待办`]];
  sheet.getRange("A2:E2").format = { font: { name: "Arial", size: 15, bold: true, color: "#17365D" }, rowHeight: 26 };
  sheet.getRange("A3").values = [[`聊天日期：${targetDate}；待办 ${todoRows.length} 项`]];
  sheet.getRange("A3:E3").format.rowHeight = 22;
  sheet.getRange("A4:E4").values = [["群", "负责人", "待办事项", "截止时间", "状态"]];
  sheet.getRange("A4:E4").format = { fill: "#17365D", font: { name: "Arial", size: 11, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", rowHeight: 30 };
  if (todoRows.length) sheet.getRange(`A5:E${end}`).values = todoRows.map(a => [a.group, a.sender, a.task, a.timing, a.status]);
  else sheet.getRange("C5").values = [["当日无符合规则的待办"]];
  for (const [column, width] of [["A", 38], ["B", 25], ["C", 76], ["D", 30], ["E", 12]]) sheet.getRange(`${column}:${column}`).format.columnWidth = width;
  sheet.getRange(`E5:E${end}`).format.fill = "#FFF2CC";
  sheet.getRange(`E5:E${end}`).dataValidation = { rule: { type: "list", values: ["待确认", "进行中", "已完成", "阻塞"] } };
  sheet.tables.add(`A4:E${end}`, true, "CompactTodoTable");
  sheet.freezePanes.freezeRows(4);
  sheet.getRange(`A5:E${end}`).format.autofitRows();
  return { workbook, todoRows };
}
