#!/usr/bin/env bash
# Rewrite a dack config's CODE paths (bridge, MCP servers, secrets providers) to the container image's
# baked-in /app locations, while leaving all STATE paths (soul_repo, db_path, runlog_db, secrets,
# identities) RELATIVE so they resolve under the bind-mounted /duck volume (the container's cwd).
# Secret VALUES are untouched. Idempotent. Usage:
#   scripts/dockerize-config.sh dack.config.yaml > /srv/ducks/<duck>/dack.config.yaml
set -euo pipefail
src="${1:-dack.config.yaml}"
sed -E \
  -e 's#(run, )openclaude-bridge/#\1/app/openclaude-bridge/#g' \
  -e 's#(run, )recall-mcp/#\1/app/recall-mcp/#g' \
  -e 's#("python3", ")secrets-providers/#\1/app/secrets-providers/#g' \
  -e 's#^([[:space:]]*bridge_dir: )openclaude-bridge[[:space:]]*$#\1/app/openclaude-bridge#' \
  "$src"
