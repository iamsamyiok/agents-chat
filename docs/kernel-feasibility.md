# 内核替换可行性分析:OpenCode → Claude Code / Codex / pi

> 结论先行:三个内核均可行,均不需要改动上层编排(orchestrator/store/server),
> 改造集中在 `app/lib/agent.js` 一个文件内。建议引入「内核适配器」抽象,
> 优先级 **pi ≥ Claude Code > Codex**(理由见文末)。
> 本文仅分析,不实施。CLI 参数截至 2026-08,以官方文档为准。

## 一、现有内核集成面(替换时必须满足的 7 个依赖点)

当前 `agent.js` 对 OpenCode 的全部依赖:

| # | 依赖点 | 现状 |
|---|--------|------|
| 1 | 一次性非交互执行 | `opencode run --format json`,prompt 经 stdin 传入 |
| 2 | stdout NDJSON 事件流 | `text` / `tool_use` / `error` 三类事件实时回调 |
| 3 | 模型指定(可选) | `-m provider/model`,留空用默认 |
| 4 | 权限自动批准 | `--auto`(无人值守必需) |
| 5 | 工作目录 | spawn 的 `cwd` = 全局统一工作目录 |
| 6 | 每次调用全新会话 | 无上下文残留,任务间隔离 |
| 7 | 停止 = 杀进程树 + 认证内核自管 | killTree;app 不做任何 API/密钥配置 |

其中 #1/#5/#6/#7 是通用进程语义,任何 CLI 内核天然满足;
真正的适配工作在 **#2 事件流解析** 和 **#3/#4 参数映射**。

## 二、逐项分析

### 1. Claude Code(Anthropic)

| 维度 | 情况 |
|------|------|
| 安装 | `npm install -g @anthropic-ai/claude-code`,Node 18+ |
| 非交互模式 | `claude -p` print 模式,stdin 可管道传入 prompt,退出码可判成败 |
| 事件流 | `--output-format stream-json --verbose` 输出 NDJSON:`system/init`、`assistant`(content blocks:text / tool_use)、`user`(工具结果)、`result`(最终) |
| 权限 | `--dangerously-skip-permissions` 全自动,或 `--permission-mode acceptEdits` + `--allowedTools` 精细控制 |
| 模型 | `--model`,仅 Anthropic 系(订阅或 API) |
| 系统提示词 | `--append-system-prompt` 官方支持,优于现状(现在拼 prompt) |
| 防失控 | `--max-turns` 上限;`--bare` 减少冷启动隐式上下文(默认 -p 会加载完整会话环境,单次可达 150k tokens) |
| 认证 | Anthropic 订阅(Pro/Max)登录或 `ANTHROPIC_API_KEY`,可经 `ANTHROPIC_BASE_URL` 接网关 |

**事件映射**(改 `handleEventLine` 即可):
- `assistant` 消息中 `type:"text"` 块 → 现有 `text` 事件
- `type:"tool_use"` 块 → 现有 `tool_use` 事件;其 `input` 的 `file_path` / `command` 键与现有 `toolTarget()` 提取逻辑直接兼容
- `result` → done

**评估:可行性高,工作量最小(约 1-2 天)**
- 优点:文档最完善、headless 是一等公民、事件 schema 稳定、`--append-system-prompt`/`--max-turns`/`--bare` 都是现成的
- 代价:模型锁定 Anthropic;订阅/按量计费;冷启动上下文开销大(必须用 `--bare` 控制);闭源(免费使用但条款约束)
- 风险:官方明示 CLI 参数迭代快,需锁版本 + 做参数探测

### 2. Codex CLI(OpenAI)

| 维度 | 情况 |
|------|------|
| 安装 | `npm install -g @openai/codex`(Rust 二进制经 npm 分发) |
| 非交互模式 | `codex exec "prompt"`,`-` 从 stdin 读 prompt;`--ephemeral` 不留会话 |
| 事件流 | `--json` 输出 JSONL:`thread.started` / `turn.started` / `item.*(item 类型含 agent_message、reasoning、command_execution、file_change 等)`;`--output-last-message <file>` 可直接取最终答复;另有 `codex app-server`(JSON-RPC over stdio)适合更深集成 |
| 权限 | 沙箱模型:`--sandbox read-only / workspace-write / danger-full-access`,`--full-auto`,`--dangerously-bypass-approvals-and-sandbox`;exec 模式本就无交互审批 |
| 模型 | `-m`,OpenAI 系;config.toml 可配自定义 provider(如 DeepSeek 兼容端点) |
| 认证 | ChatGPT Plus/Pro OAuth(`codex login`)或 `OPENAI_API_KEY` |

**事件映射**:
- `agent_message` → `text`
- `command_execution`(含 command)/ `file_change`(含路径)→ `tool_use`,键名与 `toolTarget()` 大体兼容
- 需要「输出文件写入工具过程」的地方,`reasoning` 项可忽略或映射为 thinking

**评估:可行,工作量中等(约 2-3 天)**
- 优点:沙箱分级与企业友好;`app-server` 常驻进程模式可省去每次冷启动;Apache-2.0 开源
- 代价/风险:
  - 默认要求 git 仓库或受信目录 → 需 `--skip-git-repo-check` 或预写 `~/.codex/config.toml` 的 projects 信任,首次无人值守运行有交互风险
  - `--json` 事件 schema 仍在演进(曾名 `--experimental-json`),需容错解析
  - Windows 沙箱依赖项有坑(社区反馈)
  - 模型默认锁定 OpenAI 系

### 3. pi(badlogic / Earendil,MIT)

| 维度 | 情况 |
|------|------|
| 安装 | `npm install -g @earendil-works/pi-coding-agent`(早期发布于 `@mariozechner` 作用域,以 npm 实际为准) |
| 非交互模式 | 官方四种模式:interactive / **print(JSON)** / **RPC** / **SDK** —— 后三者为嵌入场景设计(OpenClaw 即用 pi 作内核) |
| 事件流 | print-JSON 模式输出结构化事件;会话格式是文档化的 JSON 树,全程可观测(工具调用输入输出完整记录) |
| 权限 | 无权限弹窗(哲学:靠容器隔离或自建流程)→ 无人值守场景反而省事 |
| 模型 | 30+ provider(Anthropic/OpenAI/Google/DeepSeek/Groq…),OAuth 可用 ChatGPT/Copilot 订阅 |
| 认证 | `~/.pi/agent/auth.json`,多 provider 并存 |
| 深度集成 | `pi-agent-core` 可作为 SDK 直接嵌入我们的 Node 进程(in-process,无子进程);RPC 模式为 JSON-RPC over stdio 常驻 |

**评估:可行性最高、上限最高(基础接入 2 天;RPC/SDK 深度接入 3-4 天)**
- 优点:MIT 开源;多 provider 与 OpenCode 定位最接近(用户自带钥匙);极简内核无隐式上下文注入(作者明确反对「背后塞 context」),与我们「过程透明」的产品方向一致;SDK 模式可消灭进程冷启动,天然支持树状会话
- 风险:项目年轻(2025-08 起)、API 变化快、社区规模小于前两者;npm 作用域迁移过,依赖需锁死版本;「无权限控制」意味着安全边界完全交给使用方(建议文档提示容器运行)

## 三、对照总表

| 依赖点 | Claude Code | Codex | pi |
|--------|-------------|-------|-----|
| stdin 传 prompt | ✅ `-p` + 管道 | ✅ `exec -` | ✅ |
| 流式 NDJSON | ✅ stream-json,schema 稳定 | ⚠ `--json`,schema 演进中 | ✅ print-JSON / RPC |
| 工具过程可见 | ✅ tool_use 块 | ✅ command/file 项 | ✅ 完整会话树 |
| 无人值守权限 | ✅ skip-permissions | ✅ 沙箱分级(更安全) | ✅ 无弹窗(需自担边界) |
| 模型自由度 | ❌ 仅 Anthropic | ⚠ OpenAI + 自配 provider | ✅ 30+ provider |
| 系统提示词 | ✅ 官方参数 | ⚠ 拼进 prompt | ✅ |
| 全新会话/杀进程 | ✅ | ✅ | ✅(SDK 模式为进程内停止) |
| 嵌入式深度集成 | ❌ 仅 CLI | ⚠ app-server(JSON-RPC) | ✅ SDK in-process |
| 开源 | ❌ 闭源免费 | ✅ Apache-2.0 | ✅ MIT |
| 预估工作量 | 1-2 天 | 2-3 天 | 2-4 天 |

## 四、建议路线(如未来实施)

1. **先做适配器抽象**:把 `agent.js` 中 `spawnOpenCode`/`handleEventLine` 抽为
   `RunnerAdapter { detect(), buildArgs(), parseEvent() }`,按
   `AGENTS_CHAT_KERNEL=opencode|claude|codex|pi` 选择。上层零改动,新内核只写一个 adapter 文件。
2. **优先级 pi ≥ Claude Code > Codex**:
   - 追求「用户自带钥匙、多模型」的产品定位延续 → **pi** 最贴合,且 SDK 模式长期收益最大(常驻进程、树状会话、无冷启动)
   - 追求最快落地、文档最稳 → **Claude Code** 改动量最小,但模型与费用锁定 Anthropic
   - **Codex** 沙箱最安全,适合企业场景,但首次信任/JSON 演进/Windows 三处坑需趟
3. **通用注意**:所有内核都要处理(a)npm 全局安装的 Windows .cmd 垫片 spawn 问题(现有 `findOpenCode` 逻辑可复用);(b)版本锁定与 `--version` 探测;(c)帮助页内核状态三态(demo/missing/ok)扩展为多内核枚举。
