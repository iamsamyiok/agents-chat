#!/usr/bin/env bash
# Agents Chat Portable 启动脚本 (Linux / macOS)
cd "$(dirname "$0")"

# 优先使用包内 Node
if [ -f "./bin/node" ] && [ -x "./bin/node" ]; then
  NODE="./bin/node"
else
  NODE="$(command -v node || true)"
  if [ -z "$NODE" ]; then
    echo "[错误] 未找到 Node.js，且包内 bin/node 缺失。请重新下载完整包。"
    exit 1
  fi
fi

PORT="${AGENTS_CHAT_PORT:-3456}"
echo "启动 Agents Chat (port $PORT)..."
"$NODE" app/server.js --port "$PORT" &
SERVER_PID=$!

# 等待服务就绪后自动打开浏览器
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then
    (xdg-open "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT" 2>/dev/null || true) &
    break
  fi
  sleep 0.5
done

wait $SERVER_PID
