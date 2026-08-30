# Agents Chat

一个页面指挥一支 AI 智能体团队：你说需求，管家拆解调度，多个智能体并行干活、互相验收。本地运行、数据不出本机，支持免安装单文件 exe。

> 生态位说明：同类开源工具 Vibe Kanban（28k★）已停止维护、Crystal 已转商业化，Agents Chat 是这个赛道持续维护的免费开源选择，并额外提供定时任务、人工审批、卡牌协作等编排能力。

## 30 秒上手

```bash
# 安装（Node >= 18；也可直接下载免安装 exe，见下）
npm install -g agents-chat-cli

# 启动：自动打开浏览器；首次打开有新手引导，点「一键体验示例」即可看完整流程
agents-chat
```

没装 AI 内核也能跑：未检测到内核时自动进入演示模式（模拟输出），先体验界面再安装真实内核。

```bash
# 推荐内核（任选其一，装完重启 agents-chat 即真实执行）
npm install -g opencode-ai
```

## 核心玩法

| 能力 | 说明 |
|---|---|
| 群聊编排 | 直接输入需求，管家智能体拆解成阶段计划，调度子智能体并行执行，自动验收不合格返工 |
| 批量任务 | 粘贴一段文本一次导入多条任务（`1. xxx` 每行一条），可拖拽排序、批量执行 |
| 定时任务 | 行首写时间即定时（`2026-08-18 13:07 生成日报`），到点自动执行，停机错过的启动时补跑，可开机自启 |
| Git 隔离 | 导入时勾选「Git 隔离执行」：每任务独立 worktree 分支互不污染，完成后逐文件看 diff、一键合并或丢弃 |
| 人工审批 | 可选在「方案确定后 / 最终交付前」暂停等你点头，超时 10 分钟自动否决 |
| 完成通知 | 页面在后台弹系统通知；webhook 转发钉钉/飞书/自建中转 |
| 单聊工作台 | 与 OpenCode 单体多轮续聊；任务链支持 `-` 接续上一会话、`//` 并行执行 |
| 卡牌协作 | 每个智能体一张卡牌实时直播工作过程，可中途插话纠偏或委派转交 |

## 安装方式

### npm（推荐）

```bash
npm install -g agents-chat-cli
```

> 旧包名 `@iamsamyiok/agents-chat` 同步发布，两个包内容一致，命令都叫 `agents-chat`。

### 免安装单文件 exe

从 [Releases](https://github.com/iamsamyiok/agents-chat/releases) 下载对应平台文件（Windows / Linux / macOS Intel / Apple Silicon），双击即用，数据保存在 exe 旁 `.data/` 目录。SHA-256 校验值见 checksums.txt。

- Windows SmartScreen 提示「已保护你的电脑」→「更多信息」→「仍要运行」
- macOS 首次运行：`xattr -d com.apple.quarantine agents-chat-darwin-*`

## 常用命令

```bash
agents-chat          # 启动（后台运行，自动开浏览器）
agents-chat status   # 查看运行状态
agents-chat stop     # 停止（自动清理执行中的 AI 子进程）
agents-chat update   # 一键升级到最新版
agents-chat autostart on   # 开机自启（定时任务无人值守推荐开启）
```

## 配置

配置文件位于 `~/.agents-chat/.env`（exe 形态在 `.data/.env`），全部可省略：

```bash
AGENTS_CHAT_WEBHOOK_URL=      # 任务完成转发地址（钉钉/飞书中转）
AGENTS_CHAT_PRUNE_DAYS=15     # 历史数据保留天数
AGENTS_CHAT_TIMEOUT_MS=600000 # 单任务超时
AGENTS_CHAT_AUTO_APPROVE=0    # 关闭 OpenCode 自动放行
```

完整说明见仓库 `.env.example` 与页面内「帮助」。

## 支持的执行内核

OpenCode（推荐）/ Claude Code / Codex CLI / pi，页面右上角可切换。多智能体编排深度适配 OpenCode，其余内核以单轮对话方式执行。

## 开发

```bash
git clone https://github.com/iamsamyiok/agents-chat
cd agents-chat && npm install
AGENTS_CHAT_MOCK=1 npm start   # 演示模式开发，无需内核
npm test                       # 66 个测试用例
```

零运行时依赖，Node 原生模块实现（HTTP/SSE/存储均为自研轻量层）。

## License

MIT
