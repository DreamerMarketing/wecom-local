# 企业微信外部群每日待办

这套流程读取当前 macOS 企业微信桌面端账号可见的外部群，分析上海时区的昨天，生成脱敏 Excel，并可发送到企业微信群机器人。

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

## Codex 定时任务

在 Codex Desktop 中创建本地项目定时任务，项目指向当前仓库，提示词只调用提交到仓库的入口：

```text
使用 $wecom-daily-external-actions，在 /path/to/wecom-local 项目运行
scripts/run-wecom-daily-external-actions.sh --send。按 Asia/Shanghai 分析昨天，
要求所有外部群读取成功；保留生成的 Excel，并报告采集和发送结果。
```

定时任务的时间和状态属于 Codex Desktop 本地配置，不写入 Git。仓库提交内容提供可复现的 Skill、脚本、配置示例和运行文档。

## 隐私边界

- 不提交真实 webhook、聊天原文、会话 ID、群名、联系人、导出文件或截图。
- Excel 写入前隐藏 URL、邮箱、手机号、长数字串和长账号标识。
- 运行失败时保留脱敏 Excel 和摘要，不把原始聊天历史落盘。
