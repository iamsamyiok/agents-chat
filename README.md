# agents-chat (npm 包版)

多智能体群聊工具，通过 npm 全局安装后可使用 `agents-chat` 命令启动。

## 安装

```bash
npm install -g agents-chat
```

## 前置要求

本机需已安装任一 AI 执行内核：

- **OpenCode** (推荐): `npm install -g opencode-ai`
- **Claude Code**: `npm install -g @anthropic-ai/claude-code`
- **Codex CLI**: `npm install -g @openai/codex`
- **pi**: `npm install -g @earendil-works/pi-coding-agent`

## 快速开始

```bash
# 启动服务（后台运行，自动打开浏览器）
agents-chat

# 查看状态
agents-chat status

# 停止服务
agents-chat stop
```

默认访问 http://localhost:3456

## 配置

编辑 `~/.agents-chat/.env` 文件进行配置。

详见原始项目文档。
