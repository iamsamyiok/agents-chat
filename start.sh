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

# 已有服务在跑：直接打开页面
if curl -s -o /dev/null -m 2 "http://localhost:$PORT/api/health"; then
  (xdg-open "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT" 2>/dev/null || true) &
  exit 0
fi

echo "启动 Agents Chat (port $PORT)...（后台运行，日志见 .data/server.log；全部页面关闭后空闲约 1 分钟自动退出）"
nohup "$NODE" app/server.js --port "$PORT" >/dev/null 2>&1 &

# 等待服务就绪后自动打开浏览器，随后本脚本退出（终端窗口可关闭）
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then
    (xdg-open "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT" 2>/dev/null || true) &
    break
  fi
  sleep 0.5
done
