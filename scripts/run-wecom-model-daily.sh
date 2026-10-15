#!/bin/bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi
export WECOM_REPO="$repo_root"
export WECOM_NODE_BIN="${WECOM_NODE_BIN:-$(command -v node)}"
if [[ -z "${WECOM_ARTIFACT_TOOL:-}" ]]; then
  export WECOM_ARTIFACT_TOOL="$(find "$HOME/.cache/codex-runtimes" -type f -path '*/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs' -print -quit 2>/dev/null)"
fi
exec "$WECOM_NODE_BIN" "$script_dir/wecom_model_daily.mjs" "$@"
