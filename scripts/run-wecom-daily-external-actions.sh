#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

# Optional .env is local-only and ignored by Git. It may define the webhook,
# WECOM_LOCAL_BIN, WECOM_ARTIFACT_TOOL, or WECOM_NODE_BIN variables.
if [[ -f "$repo_root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$repo_root/.env"
  set +a
fi

node_bin="${WECOM_NODE_BIN:-}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "Node.js is required. Set WECOM_NODE_BIN to the bundled Node executable." >&2
  exit 1
fi

binary_path="${WECOM_LOCAL_BIN:-$repo_root/target/release/wecom-local}"
if [[ ! -x "$binary_path" ]]; then
  echo "Missing executable: $binary_path" >&2
  echo "Run: cargo build --release" >&2
  exit 1
fi

artifact_tool="${WECOM_ARTIFACT_TOOL:-}"
if [[ -z "$artifact_tool" ]]; then
  local_candidate="$repo_root/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs"
  if [[ -f "$local_candidate" ]]; then
    artifact_tool="$local_candidate"
  fi
fi

# Codex Desktop bundles artifact-tool outside the repository. Detect it when
# available, while keeping the committed code independent of one user's path.
if [[ -z "$artifact_tool" && -n "${WECOM_RUNTIME_ROOT:-}" && -d "$WECOM_RUNTIME_ROOT" ]]; then
  artifact_tool="$(find "$WECOM_RUNTIME_ROOT" -type f -path '*/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs' -print -quit 2>/dev/null || true)"
fi
if [[ -z "$artifact_tool" && -n "${HOME:-}" && -d "$HOME/.cache/codex-runtimes" ]]; then
  artifact_tool="$(find "$HOME/.cache/codex-runtimes" -type f -path '*/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs' -print -quit 2>/dev/null || true)"
fi
if [[ -z "$artifact_tool" || ! -f "$artifact_tool" ]]; then
  echo "Missing artifact-tool. Set WECOM_ARTIFACT_TOOL to artifact_tool.mjs." >&2
  exit 1
fi

export WECOM_REPO="$repo_root"
export WECOM_LOCAL_BIN="$binary_path"
export WECOM_ARTIFACT_TOOL="$artifact_tool"
exec "$node_bin" "$repo_root/scripts/wecom_daily_external_actions.mjs" "$@"
