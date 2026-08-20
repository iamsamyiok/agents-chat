# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-19
- Context: Discovered by Agent while performing the v3.14.0 release task
- Category: Operations & Deployment
- Instructions:
  - 发布流程：功能开发在当前 fix/feat 分支完成 → git push 到 origin → 切到 master 并 pull → git merge --no-ff 分支到 master → git tag vX.Y.Z → git push origin master + tag → gh release create vX.Y.Z（标题带版本号与功能摘要，notes 列出主要变更）。
  - 远程仓库为 GitHub：https://github.com/iamsamyiok/agents-chat，push 偶发 HTTP 500 时直接重试即可。
  - 每个版本 commit message 需带上版本号（如 "(v3.14.0)"）。

[Project Knowledge Summary]
- Date: 2026-08-20
- Context: Discovered by Agent while building and smoke-testing the dual-agent project
- Category: Operations & Deployment
- Instructions:
  - dual-agent（/workspace/dual-agent，远程 https://github.com/iamsamyiok/dual-agent，公开）：零依赖 Node（要求 18+），`node server.js` 即跑，默认端口 3788 绑定 127.0.0.1；一键启动 `start.bat/start.sh/start.command`（tools/probe.js 探测端口）。脱机演示用 `DUAL_AGENT_MOCK=1`，测试时加 `DUAL_AGENT_DATA=<tmp> DUAL_AGENT_PLUGINS_DIR=<tmp> PORT=<p>` 隔离。v0.3.0 已发布 release。
  - dual-agent 冒烟测试：`node test/smoke.js`（34 项断言：语法+单元+MOCK e2e），提交前必跑。注意 e2e 中评审提示测试前，外层对话会把 reviewMark 推进到水位，注入失败日志需 ≥5 条。
  - dual-agent 内层工具调用健壮性铁律（v0.3.1~v0.3.2 事故教训）：① LLM 产出的 tool_calls.arguments 可能是非法 JSON（小模型常见键无引号/截断），回填 messages 前必须 sanitize，否则下一轮 API 400 崩会话；② 插件 params.required 必须在 runPlugin 框架层统一校验，缺参返回可重试错误让 LLM 自纠，不能让插件拿残参炸出 EISDIR 类费解错误；③ 部分 API（实测 agnes-2.5-flash）会把超大 arguments（>约2KB）拆到多个 index 流，reassembleCalls 重组（v0.3.2）是唯一防线，改动 inner.js 流解析时勿绕过；④ 插件"未命中/未找到"类结果必须 throw 让框架标记失败（错误前缀正则 /^(插件 .+?(加载失败|执行出错|调用被拒绝))/），返回普通字符串会被模型误读为成功。
  - dual-agent Agnes 内层配置（.data/config.json，不入库）：base_url=https://api.agnes-ai.cn/v1，model=agnes-2.5-flash（免费、支持工具调用）。监督真实任务用 SSE 流式看 /api/inner/chat 事件。长驻服务必须用 background_terminal（bash 的 `&` 会被清理）。
  - dual-agent 发布流程（与 agents-chat 不同，单人开发）：直接 master 提交（commit message 带版本号）→ push → tag → gh release create，无 merge --no-ff。
  - dual-agent 内层真实监督方法论（v0.3.3 积累）：长任务用 SSE 流式看 /api/inner/chat 事件逐条核对；agnes-2.5-flash 的间歇性缺陷有三类——①多调用/长参数时 arguments 整体丢失（空参，模型会陷入重试死循环，需框架止损而非模型自纠）②大参数拆流 ③缺字段非法 JSON；模型对『未命中/失败类』返回字符串易误读为成功，插件必须 throw 让框架标记；模型会忘记 append 语义用普通 write 续写覆盖丢前文；写长文时模型还会自发改用 bash cat >> 绕路（可接受但监控关注）。
  - dual-agent 外层 opencode 检测必须效仿 agents-chat 的 findCli（app/lib/agent.js）：Windows 上 `where` 先返回无扩展名 bash 垫片（spawn 报 ENOENT），须优先 `.exe/.cmd/.bat/.com` 且 `.cmd/.bat` 用 `shell:true`；超时杀进程树用 `taskkill /pid <pid> /T /F`。测真实外层链路可写假 NDJSON 脚本并用 `DUAL_AGENT_OPENCODE_CMD=<path>` 指定（注意 printf 生成，echo 会把 `\n` 转成真实换行弄断 JSON）。
  - 语法校验：`node --check server.js lib/*.js plugins/*.js`；前端用 `new Function` 校验内联 script。
  - e2e 冒烟链路：/api/health → /api/plugins（4 基础插件应 loaded）→ /api/inner/chat（mock 走 bash→write 工具循环）→ /api/outer/chat（建议入队）→ /api/proposals/decide → /api/rollback（连续两次回滚应在两状态间交替）。
  - 测试后注意清理：批准过的插件会真实写入 plugins/ 目录（残留文件会污染后续测试清单），用 /api/plugins/delete 清理；workspace/ 与 .data/ 已在 .gitignore。
  - 本机未安装 opencode，真实外层链路无法本机验证，只能 mock。
- Category: Environment Configuration
- Instructions:
  - dual-agent 仓库需 local 配置 git 身份（同 agents-chat）：`git config user.name "iamsamyiok"` + `git config user.email "monkeycode-ai@chaitin.com"`；全局无身份配置，新仓库首次提交会报 Author identity unknown。
