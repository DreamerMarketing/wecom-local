export const platforms = ["抖音", "小红书", "美团"];
const platformRules = [["抖音", /抖音|来客|巨量|千川/], ["小红书", /小红书|小红薯|聚光/], ["美团", /美团|大众点评|点评/]];
export function inferPlatforms(text, group = "") {
  const direct = platformRules.filter(([, rule]) => rule.test(text)).map(([name]) => name);
  return direct.length ? direct : platformRules.filter(([, rule]) => rule.test(group)).map(([name]) => name);
}

// Preserve the requested action and object rather than inventing work from topics.
const verbs = /完成|新建|反馈|充值|回复|触达|回访|邀约|发布|上架|下架|提交|审核|检查|核验|调整|优化|暂停|停止|恢复|收集|整理|回传|拍摄|剪辑|制作|更新|修改|确认|安排|跟进|复盘|培训|申诉|处理|补充|提供|发送|上传|核对|开启|关闭|维护|配置|联系|报名|参加|准备|对接|排期/;
export function extractActions(text, group = "") {
  const result = [];
  let context = inferPlatforms("", group);
  for (const clause of String(text).split(/[\n。；;！？!?]+/)) {
    const value = clause.trim();
    if (!value) continue;
    if (/^联系方式\s*[:：]/.test(value)) continue;
    const direct = inferPlatforms(value);
    if (direct.length) context = direct;
    const directive = value.match(/请|需要|务必|记得|建议/);
    const offset = directive ? directive.index + directive[0].length : 0;
    const match = value.slice(offset).match(verbs);
    if (!match) continue;
    match.index += offset;
    const before = value.slice(0, match.index);
    if (!directive && /已经|已(?:完成|发布|上传|上架|下架|调整|暂停|停止|加入)|正在|目前/.test(value)) continue;
    if (!directive && /提供.*帮助.*(?:经营|履约|促活|营销)/.test(value)) continue;
    if (!directive && /已(?:经)?|完成了|刚刚|昨天|昨日/.test(before)
        && !/请|需要|务必|待|明天|今天|后续|接下来/.test(before)) continue;
    if (/不(?:用|需要|要)|无需|不要|不用再/.test(before)) continue;
    // A bare status such as “正在审核” or “发布效果很好” is not a task.
    if (!/请|需要|务必|待|安排|尽快|及时|记得|建议|今天|今日|明天|本周|下周|每日|每天|每周|后续|接下来|计划|截止|之前/.test(value)
        && !new RegExp(`^(?:@\\S+\\s+|\\d+[、.）)]\\s*)?${match[0]}`).test(value)) continue;
    let action = value.slice(match.index).trim();
    if (/^调整的地方.*反馈/.test(action)) action = `反馈需要调整的页面内容${/没问题.*上传/.test(action) ? "；无修改意见时确认上传" : ""}`;
    const object = action.slice(match[0].length).replace(/^[：:，,\s]+/, "").replace(/一下|一会|尽快|及时|吧|呢|哈|哦|呀|~|～|[\s“”"「」]/g, "");
    if (!object || /^方式[:：]/.test(object)) continue;
    result.push({ text: value, task: action, platforms: direct.length ? direct : [...context] });
  }
  return result;
}
