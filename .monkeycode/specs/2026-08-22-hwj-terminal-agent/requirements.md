# hwj 终端智能体 需求文档

Feature Name: hwj-terminal-agent
Updated: 2026-08-22

## Introduction

将 dual-agent 内层 Agent（chatInner 引擎 + 21 个插件）的完整能力封装为一个独立终端智能体「hwj」，对标 opencode 的终端 TUI 形态。用户在 Windows 桌面双击启动脚本后，自动打开 WSL 终端并进入 hwj 交互界面，以纯终端方式完成文件读写、命令执行、调研搜索、长文创作等任务。设计为纯增量：不修改 server.js / lib / plugins 既有代码。

## Glossary

- **hwj 智能体**: 本需求的终端智能体产品，内核为 dual-agent 内层引擎
- **内层引擎**: `lib/inner.js` 的 chatInner 工具调用循环（OpenAI 兼容 API + 插件流）
- **TUI**: Terminal User Interface，终端文本用户界面（readline + ANSI 转义序列实现）
- **build 模式**: 全插件可用的执行模式（对标 opencode build agent）
- **plan 模式**: 只读插件可用的分析模式（对标 opencode plan agent）
- **双击启动链**: Windows 双击 hwj.bat → wsl.exe → bash → node hwj/hwj.js 的调用链
- **事件流**: chatInner 的 onEvent 回调事件（text / tool_call / tool_result / info / usage）
- **工作区**: workspaces/ 下的任务域（memory/todo/uploads 等所属），与 server 共享

## Requirements

### R1 双击启动

**User Story:** AS Windows 用户, I want 双击一个图标就进入 hwj 终端交互, so that 无需记忆命令即可使用智能体。

#### Acceptance Criteria

1. WHEN 用户双击 hwj.bat, the hwj 启动链 SHALL 通过 wsl.exe 在默认 WSL 发行版中启动 node 并进入 hwj TUI。
2. IF WSL 未安装或无发行版, the hwj.bat SHALL 在控制台显示中文安装指引并以非零码退出。
3. IF WSL 内未安装 Node.js 或版本低于 18, the hwj.bat SHALL 显示中文安装指引（含 apt/NodeSource 命令）并以非零码退出。
4. WHEN hwj.js 以交互式 TTY 启动, the 系统 SHALL 进入 TUI；IF 以非 TTY（管道/CI）启动, the 系统 SHALL 打印诊断信息并以非零码退出。
5. WHEN 用户在 macOS/Linux 双击 hwj.command, the 系统 SHALL 通过系统终端启动同一 hwj TUI。

### R2 TUI 交互界面

**User Story:** AS 终端用户, I want 类 opencode 的消息流 + 输入区 + 状态栏界面, so that 在终端里流畅地与智能体对话。

#### Acceptance Criteria

1. WHILE TUI 运行, the 系统 SHALL 显示三区布局：消息流滚动区、输入区、状态栏（模式/工作区/token 用量/轮次）。
2. WHEN 用户在输入区键入文本并按 Enter, the 系统 SHALL 将消息加入会话并触发内层引擎执行。
3. WHEN 内层引擎产生 text 事件, the 系统 SHALL 实时重绘当前轮回复区（流式效果）。
4. WHEN 内层引擎产生 tool_call 事件, the 系统 SHALL 显示工具行（插件名 + 参数摘要 + 转圈指示）；WHEN 对应 tool_result 到达, the 系统 SHALL 将该行就地更新为 通过/失败 + 耗时。
5. WHEN 内层引擎产生 info 事件（框架注入提示/返修/续航）, the 系统 SHALL 以弱化样式行显示。
6. WHILE 任务执行中, the 输入区 SHALL 保持可输入状态并支持排队提交（对齐 server 排队语义，上限 5 条）。
7. WHEN 终端宽度变化, the 系统 SHALL 按新宽度重排状态栏与工具行摘要。

### R3 双模式（build / plan）

**User Story:** AS 谨慎的用户, I want 只读分析模式防止误改文件, so that 探索陌生代码库时零风险。

#### Acceptance Criteria

1. WHEN 用户输入 /mode plan, the 系统 SHALL 切换为 plan 模式并在状态栏反映。
2. WHILE plan 模式生效, the 系统 SHALL 拦截写类插件（write/edit/bash 写操作等）并返回可读拒绝提示。
3. WHEN 用户输入 /mode build, the 系统 SHALL 恢复全插件可用。

### R4 配置共享

**User Story:** AS 网页版用户, I want 终端版直接用已配好的 API, so that 零重复配置。

#### Acceptance Criteria

1. WHEN `.data/config.json` 存在完整 inner 配置（base_url/api_key/model）, the hwj SHALL 直接复用该配置。
2. IF 配置缺失, the hwj SHALL 首次启动时进入 /config 交互向导（逐项输入）并写回同一 config.json。
3. WHEN 用户输入 /config, the 系统 SHALL 重新进入配置向导；IF 新配置与旧值相同且用户直接回车, the 系统 SHALL 保留旧值。
4. IF 配置了多个 profile, the /model 命令 SHALL 支持查看与切换当前生效 profile。

### R5 会话独立与持久化

**User Story:** AS 双端用户, I want 终端与网页各自独立的对话, so that 互不污染上下文。

#### Acceptance Criteria

1. the hwj 会话 SHALL 持久化到 `workspaces/<ws>/hwj-messages.json`，与 server 的 inner-messages 分片互不读写。
2. WHEN hwj 重新启动, the 系统 SHALL 恢复最近一次会话历史并显示条数摘要。
3. WHEN 用户输入 /reset, the 系统 SHALL 清空当前会话并重建系统提示。
4. the 工作区级数据（memory/todo/skills/uploads）SHALL 与 server 共享（同一目录同一套插件读写）。

### R6 命令系统

**User Story:** AS 高级用户, I want 斜杠命令管理智能体状态, so that 不退出 TUI 即可完成常用操作。

#### Acceptance Criteria

1. WHEN 用户输入 /help, the 系统 SHALL 列出全部命令及一句话说明。
2. the 系统 SHALL 至少提供：/help /config /mode /model /workspace /reset /history /usage /memory /todo /export /clear /exit。
3. WHEN 用户输入未知命令, the 系统 SHALL 提示未知命令并建议 /help。

### R7 中断与退出

**User Story:** AS 用户, I want 安全中断长任务与退出, so that 误按不丢会话。

#### Acceptance Criteria

1. WHEN 任务运行中用户按 Ctrl+C, the 系统 SHALL 中断当前任务（保留已完成轮次的事件与落盘记录）并返回输入态。
2. IF 空闲状态用户按 Ctrl+C, the 系统 SHALL 显示「再按一次退出」确认；WHEN 3 秒内再次按 Ctrl+C, the 系统 SHALL 持久化会话后退出。
3. WHEN 会话被中断或退出, the 落盘的 messages SHALL 保持 tool_calls 配对完整性（复用 pairSafeTail 语义）。

### R8 能力完整继承

**User Story:** AS 重度用户, I want 内层全部智能在终端可用, so that 网页版能做的终端都能做。

#### Acceptance Criteria

1. the hwj SHALL 继承内层引擎全部能力：工具调用循环、参数净化、流拆分重组、轮数预算与自动续航、上下文压缩、止损、多步/长文任务纪律注入、拒绝催促对齐。
2. the hwj SHALL 继承意图闭环：任务前抽取意图契约、每轮注记、交付核验与自动返修（plugins/intent 复用）。
3. WHEN DUAL_AGENT_MOCK=1, the hwj SHALL 走 mock 引擎支持无 API 演示与测试。
4. the hwj SHALL 支持子智能体派生（subagent 插件）与并行只读工具调用。

### R9 增量性约束

**User Story:** AS 维护者, I want hwj 完全增量, so that 现有功能零回归风险。

#### Acceptance Criteria

1. the 实现 SHALL 仅新增 hwj/ 目录与根目录启动脚本（hwj.bat / hwj.command / hwj.sh）。
2. the 实现 SHALL 保持零依赖（仅 Node 内置模块，无 node_modules）。
3. the 既有 test/smoke.js 断言 SHALL 在新增代码后全部保持通过；hwj 自身 SHALL 有独立冒烟测试（语法 + 单元 + MOCK e2e）。

### R10 可观测性

**User Story:** AS 排障用户, I want 任务过程留痕, so that 出问题可回溯。

#### Acceptance Criteria

1. WHEN 每轮工具调用完成, the 系统 SHALL 按与 server 相同格式追加 workspaces/<ws>/process.md 过程记录。
2. WHEN usage 事件到达, the 状态栏 SHALL 显示会话累计 token 与调用次数。
3. the hwj SHALL 支持 /export 将当前会话导出为 Markdown 文件到工作区。
