#!/usr/bin/env bash
# wsl-command 启动脚本
set -euo pipefail
cd "$(dirname "$0")"
exec python3 server.py "$@"
