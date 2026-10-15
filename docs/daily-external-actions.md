# 企业微信外部群每日待办

这套流程读取当前 macOS 企业微信桌面端账号可见的外部群，分析上海时区的昨天，生成脱敏 Excel，并可发送到企业微信群机器人。

当前默认由 Codex 定时任务进行大模型上下文分析。先运行
`bash scripts/run-wecom-model-daily.sh --prepare` 采集完整脱敏文本，
由 Codex 逐群阅读、关联请求与后续回复、判断未完成事项，写入带证据编号的
`reviewed.json`；再运行 `bash scripts/run-wecom-model-daily.sh --actions <reviewed.json>`
生成并审阅 Excel，最后加 `--send` 发送。详细契约见仓库
`skills/wecom-daily-external-actions/SKILL.md`。脚本本身不调用模型，
模型分析发生在 Codex 任务中；没有完成全部群审阅或读取失败时禁止发送。

以下旧 `run-wecom-daily-external-actions.sh` 命令仍保留供显式选择规则提取的用途，
不能当作大模型分析。旧本机 launchd 调度已停用，不与 Codex 任务同时运行。

## 首次配置

先构建本地只读 CLI：

```bash
cargo build --release
```

配置 webhook。真实地址只写入被 Git 忽略、权限为 600 的本地文件：

```bash
scripts/configure-wecom-daily-webhook.sh '<你的企业微信机器人 webhook>'
```

运行入口会自动使用当前仓库的 `target/release/wecom-local`，并尝试从 Codex Desktop 缓存中发现 `artifact-tool`。如果发现不了，设置：

```bash
export WECOM_NODE_BIN='/path/to/node'
export WECOM_ARTIFACT_TOOL='/path/to/artifact_tool.mjs'
```

企业微信桌面端必须已经安装、登录并保持本机可见；历史读取还需要已授权的非交互 `sudo -n`。

## 手动运行

```bash
scripts/run-wecom-daily-external-actions.sh --dry-run
scripts/run-wecom-daily-external-actions.sh --date 2026-01-01 --dry-run
scripts/run-wecom-daily-external-actions.sh --send
```

生成文件位于 `outputs/daily-wecom-todos/`。该目录已加入 `.gitignore`，其中可能包含本地业务数据，不应提交。

每次运行分别生成 `抖音运营待办事项_<date>.xlsx`、
`小红书运营待办事项_<date>.xlsx`、`美团运营待办事项_<date>.xlsx`，
各含汇总、待办清单、聊天行动明细。优先使用消息明确提到的平台，
以群名和消息内平台标题补充上下文；跨平台动作可出现在多份文件中。
未能确定平台的动作计入运行摘要的 `unclassifiedActions`，不强行分配。
待办必须包含动作及对象，保留原消息中的执行要求；纯讨论、已完成报告、
否定要求和机器人消息不作为新增待办。未明确指派负责人时标记待指派。
无动作的平台仍生成空清单。所有外部群读取成功后才允许发送三份文件，
任一读取失败则保留本地文件、返回失败并禁止发送。

## Codex 定时任务

在 Codex Desktop 中创建本地项目定时任务，项目指向当前仓库，提示词只调用提交到仓库的入口：

```text
使用 $wecom-daily-external-actions，在 /path/to/wecom-local 项目运行
模型辅助工作流：--prepare 采集完整脱敏聊天，由 Codex 按群结合上下文审阅，
写入 reviewed.json，然后 --actions 生成预览并审阅，最后 --send。
按 Asia/Shanghai 分析昨天，要求所有外部群读取成功；保留三平台 Excel，
报告采集、大模型分析及发送结果，禁止用关键词结果冒充模型分析。
```

定时任务的时间和状态属于 Codex Desktop 本地配置，不写入 Git。仓库提交内容提供可复现的 Skill、脚本、配置示例和运行文档。

## 旧本机漏跑补偿（已停用）

本机 launchd 可调用 `node scripts/wecom_daily_scheduler.mjs`，配置每天 08:00、
登录时启动及每 15 分钟检查。调度器按上海时间在 08:00 前跳过，之后补跑昨天。
使用进程锁避免重叠采集；每个平台发送前后分别原子保存状态，已成功的文件跳过。
发送断线或中断而无法确认结果时停止自动重发，需人工检查，不能保证网络请求的严格恰好一次。
状态保存于 `.local/wecom-local/daily-runs/<date>.scheduler.json`，失败的采集可在下次检查重试。
本机后台安装应位于用户 Library 中，避免 Documents 的后台文件访问限制。
关机期间不能运行，开机登录且企业微信就绪后可补跑昨天；连续多日关机需手动回填更早日期。

## 隐私边界

- 不提交真实 webhook、聊天原文、会话 ID、群名、联系人、导出文件或截图。
- Excel 写入前隐藏 URL、邮箱、手机号、长数字串和长账号标识。
- 运行失败时保留脱敏 Excel 和摘要，不把原始聊天历史落盘。
