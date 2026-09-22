---
name: wecom-daily-external-actions
description: Daily local analysis of yesterday's visible WeCom external-group chats. Use when Codex must fetch all locally visible external groups, identify employee or operations actions with owner, timing, group, priority and completion criteria, generate a sanitized Excel workbook, and optionally upload that workbook to an enterprise WeChat webhook.
---

# 企业微信每日外部群待办

Use `scripts/run-wecom-daily-external-actions.sh` from the repository root. The
implementation calls the local `wecom-local` binary and does not use the
official WeCom API to read chat history.

## Workflow

1. Resolve yesterday in `Asia/Shanghai`, or accept `--date YYYY-MM-DD` for a backfill.
2. Read every locally visible external group and its full date-bounded history.
3. Continue after per-group failures, record them in the workbook, and never claim a complete run while failures remain.
4. Identify human action messages and extract owner, group, timing, category, task, completion standard, priority, status and evidence.
5. Redact URLs, email addresses, phone numbers and long identifiers before writing workbook cells. Never persist raw chat history.
6. Generate `汇总`, `待办清单` and `聊天行动明细` sheets with editable status values `待确认`, `进行中`, `已完成` and `阻塞`.
7. Recalculate, inspect key ranges, scan formula errors, render the sheets and write the workbook to `outputs/daily-wecom-todos/`.
8. With `--send`, upload only the generated workbook to the configured WeCom robot webhook and fail if either upload or send is unsuccessful.

## Configuration

Keep secrets out of Git. Configure the local webhook once with:

```bash
scripts/configure-wecom-daily-webhook.sh '<webhook-url>'
```

The runner also accepts `WECOM_WEBHOOK_URL`, `WECOM_WEBHOOK_FILE`,
`WECOM_LOCAL_BIN`, `WECOM_ARTIFACT_TOOL` and `WECOM_NODE_BIN` environment
variables. See `.env.example` for local-only overrides.

## Commands

```bash
scripts/run-wecom-daily-external-actions.sh --dry-run
scripts/run-wecom-daily-external-actions.sh --date YYYY-MM-DD --dry-run
scripts/run-wecom-daily-external-actions.sh --send
```

The WeCom Desktop app must be installed, signed in and locally visible. Runtime
history access requires non-interactive `sudo -n` authorization; never put a
macOS password in a prompt, environment variable or file.
