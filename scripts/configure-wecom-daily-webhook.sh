#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Store the WeCom robot webhook in a local ignored file.

Usage:
  scripts/configure-wecom-daily-webhook.sh '<webhook-url>'
  WECOM_WEBHOOK_URL='<webhook-url>' scripts/configure-wecom-daily-webhook.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

webhook_url="${1:-${WECOM_WEBHOOK_URL:-}}"
if [[ -z "$webhook_url" ]]; then
  echo "Missing webhook URL." >&2
  usage >&2
  exit 2
fi
if [[ "$webhook_url" != https://qyapi.weixin.qq.com/cgi-bin/webhook/send\?key=* ]]; then
  echo "Expected a WeCom robot send webhook URL." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
config_dir="$repo_root/.local/wecom-local"
config_file="$config_dir/wecom-webhook.url"

umask 077
mkdir -p "$config_dir"
printf '%s\n' "$webhook_url" > "$config_file"
chmod 600 "$config_file"
echo "Saved webhook configuration to $config_file (permissions 600)."
