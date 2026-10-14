import test from "node:test";
import assert from "node:assert/strict";
import { inferPlatforms, extractActions } from "./daily_action_rules.mjs";

test("explicit platform wins over group; unclear platforms stay unclassified", () => {
  assert.deepEqual(inferPlatforms("请发布小红书笔记", "抖音示例群"), ["小红书"]);
  assert.deepEqual(inferPlatforms("请回复私信", "美团示例群"), ["美团"]);
  assert.deepEqual(inferPlatforms("请回复私信", "综合示例群"), []);
});
test("split platform actions and inherit headings", () => {
  const actions = extractActions("抖音：\n明天发布活动视频。小红书：请修改笔记封面。美团：今天上架套餐", "综合示例群");
  assert.deepEqual(actions.map((item) => item.platforms), [["抖音"], ["小红书"], ["美团"]]);
  assert.deepEqual(actions.map((item) => item.task), ["发布活动视频", "修改笔记封面", "上架套餐"]);
});
test("reject topic-only, completed, negative and status messages", () => {
  for (const text of ["小红书今天流量很好", "抖音视频发布效果很好", "美团正在审核套餐", "已完成发布抖音视频", "不需要充值抖音广告", "请不要发布小红书笔记", "联系方式：[手机号已隐藏]", "联系方式：", "请提供一下", "请及时充值呢", "提供海量经营工具帮助商家上品，经营，履约，促活，营销", "今天调整广告计划，目前已经发布了视频"]) {
    assert.equal(extractActions(text).length, 0, text);
  }
});
test("retain source action without adding an unrelated operation", () => {
  assert.equal(extractActions("请检查抖音广告余额")[0].task, "检查抖音广告余额");
  assert.equal(extractActions("请充值抖音广告100元")[0].task, "充值抖音广告100元");
  assert.deepEqual(extractActions("请同步更新抖音和小红书活动文案")[0].platforms, ["抖音", "小红书"]);
  assert.equal(extractActions("抖音审核不通过，请修改视频文案")[0].task, "修改视频文案");
  assert.equal(extractActions("今天需要完成蓝V认证，可用于发布笔记")[0].task, "完成蓝V认证，可用于发布笔记");
});
