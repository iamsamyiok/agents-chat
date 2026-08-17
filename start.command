#!/usr/bin/env bash
# Agents Chat Portable 启动脚本 (macOS 双击运行)
cd "$(dirname "$0")"

PORT="${AGENTS_CHAT_PORT:-3456}"
if [ -f "./bin/node" ] && [ -x "./bin/node" ]; then
  NODE="./bin/node"
else
  NODE="$(command -v node || true)"
  if [ -z "$NODE" ]; then
    echo "未找到 Node.js，且包内 bin/node 缺失。"
    read -p "按回车退出..."
    exit 1
  fi
fi

"$NODE" app/server.js --port "$PORT" &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then
    open "http://localhost:$PORT" 2>/dev/null || true
    break
  fi
  sleep 0.5
done
wait $SERVER_PID
