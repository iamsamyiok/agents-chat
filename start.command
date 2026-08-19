#!/usr/bin/env bash
# Agents Chat Portable 启动脚本 (macOS 双击运行)
cd "$(dirname "$0")"

PORT="${AGENTS_CHAT_PORT:-3456}"

# 已有服务在跑：直接打开页面
if curl -s -o /dev/null -m 2 "http://localhost:$PORT/api/health"; then
  open "http://localhost:$PORT" 2>/dev/null || true
  exit 0
fi

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

nohup "$NODE" app/server.js --port "$PORT" >/dev/null 2>&1 &
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then
    open "http://localhost:$PORT" 2>/dev/null || true
    break
  fi
  sleep 0.5
done
# 服务在后台保持运行（全部页面关闭后空闲约 1 分钟自动退出），本窗口可关闭
