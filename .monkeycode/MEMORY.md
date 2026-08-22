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
[Project Knowledge Summary]
- Date: 2026-08-22
- Context: v0.9.13/v0.9.14 开发中踩坑与真实验证经验
- Category: Testing Methods
- Instructions:
  - dual-agent test/smoke.js 中 sseResponse 是 const 定义于用例序列中部（mock SSE 构造器）；新增需要 mock fetch 的测试必须插在其定义之后，放前面会 TDZ 报错（withRetry 内非重试异常被 extractIntent 吞掉变成 null，表象是"优雅降级失败"而非 TDZ 直报）。
  - 改动 server 执行块结构（如 chatInner 包裹层重构）后，既有"静态接线"正则断言可能失配——先跑全量 smoke 再提交，失败时同步更新正则。
- Category: Troubleshooting & Debugging
- Instructions:
  - v0912-verify 验证时观察到的"首笔 curl 0 字节响应 + 旧区历史串入新区"现象，v0.9.15 已定性为 409 丢消息 + 界面渲染错位（旧任务回复排到新消息下方造成答非所问错觉），由消息排队机制（inner-queue.json + drainInnerQueue）修复。排查此类问题先查 process.md 任务头时间戳与请求时序的对应关系。
  - 意图闭环真实验证方法：跑一个三步任务（两文件+一对比），检查 process.md 中"交付核验（第 N 次）"段落与 SSE info 中"自动返修（第 x/2 轮）"；.intent.json 的 acceptance 条款质量决定核验灵敏度，可在任务原文里写精确内容要求（如 JSON 字面量）让缺口可硬核验。
  - 排队机制真实验证方法：后台起长任务（调研类 30s+），sleep 5-8s 后发第二条消息应收到 SSE queued 事件且 .data/inner-queue.json 有内容；主任务 done 后轮询 /api/inner/messages 确认排队消息自动执行入史、队列文件清空。注意短任务（文件已存在的重跑）5s 内就完成，撞不上锁窗口。
[Project Knowledge Summary]
- Date: 2026-08-22
- Context: v0.9.16 文档处理开发与真实验证
- Category: Project Knowledge (Architecture)
- Instructions:
  - mistralai/search-toolkit 仓库不存在（404）；实际项目是 mistralai/search-starter-app（Search Toolkit pypi 包的 Copier 脚手架，需 Docker+Vespa+Mistral key）。dual-agent 采用其"摄入+检索"思想做零依赖轻量版（plugins/doc.js），未引入向量库。
  - dual-agent 文档链路（v0.9.16）：前端 base64 JSON POST /api/upload（≤20MB，重名加序号）→ workspaces/<ws>/uploads/ → doc 插件 list/read/search（PDF inflate+Tj/TJ、DOCX/XLSX 手写 zip 读取器）→ 任务消息自动附加 [已上传文档] 上下文。查看走 /files/<path>（直出）与 /view/<path>（mdRender 渲染页），前端把消息中的文件路径渲染成链接。
  - PDF 纯 JS 提取的固有限界：latin1 内容流里的中文（无字体编码表）会损坏；扫描件/无 ToUnicode CID 字体提取不到文本——doc 插件对此返回可操作建议（转存 txt）。数字与英文提取可靠。
  - 测试 fixture 技巧：手写 stored zip 生成器（local header+central directory+EOCD，CRC32 手算）可构造 DOCX/XLSX 单测样本；无压缩 PDF 流直接 latin1 拼 BT/Tj 文本块，压缩流用 zlib.deflateSync 包 /Filter /FlateDecode。
[Project Knowledge Summary]
- Date: 2026-08-22
- Context: v0.9.19 长文创作质量加固真实验证
- Category: Troubleshooting & Debugging
- Instructions:
  - 长文创作纪律（server.js isLongFormTask 注入）是软约束，实测 agnes-2.5-flash 对规则 2b（append 前 read tail）/ 规则 4b（每 3 章 memory.save 一致性检查）遵守率不达标。模型倾向跳过直接续写。如需硬约束，需在框架层加：runInner 完成后检查 deliverable 质量（章节连续性+字数），FAIL 则注入修复指令重入一次。
  - 长文 verify 规则需包含：regex 检查章节标题格式（/^## 第[一二三四五六七八九十]+章/独占一行）、wc -m 真实字数≥目标、目录完整性（所有章节都存在）。仅靠 contains/line_count 不足。
  - 模型对"万字"的执行通常打折扣（报告 1.1 万字实际 6000 字符），交付说明中必须用 wc -m 客观数据，禁止信任模型的自报字数。
  - 工作区 doc-verify 的旧记忆（预算 PDF 解析）会污染后续任务——新任务必须 reset inner-messages.json 并明确告知"这是全新任务"。

[Project Knowledge Summary]
- Date: 2026-08-22
- Context: v0.9.27 Channel API 开发与真实验证（Qwen Code Channels 接入）
- Category: Troubleshooting & Debugging
- Instructions:
  - 复用 handleInnerChat 做同步接口（如 /api/channel/chat）的方法：它的事件走 sse(req,res) 直写 res（"data: {...}\n\n" 格式），mock res 必须在 write 里解析 data: 行收集事件；text 事件是快照式覆盖，取最后一个非空 text 才是最终回复，禁止 join 全部。
  - sse() 工厂内部有 15s 心跳 setInterval，靠 req/res 的 close 事件清理——mock 对象必须是 EventEmitter 且 end() 时 emit('close')，否则每次调用泄漏一个定时器。
  - 撞 innerLock 时 handleInnerChat 走 queued 分支（只发 queued+done 事件），同步接口需检测 queued 事件返回排队文案 + queued:true 标记。
  - 发布 tag 前必须核对指向（git log --oneline -1 <tag>）：v0.9.27 曾被错打在 v0.9.26 的 commit 上；错位时 git tag -d + push :refs/tags/ 删远程后重打。
  - Channel API 实测方法：DUAL_AGENT_MOCK=1 + 隔离 DATA/WS/PLUGINS 环境变量起服务，curl POST /api/channel/chat 验证返回真实任务文本；排队场景配 DUAL_AGENT_TEST_HOLD=8000 并发双发，第二发应返回 queued:true。

[Project Knowledge Summary]
- Date: 2026-08-22
- Context: v0.9.28 hwj 终端智能体开发与验证（类 opencode TUI）
- Category: Testing Methods
- Instructions:
  - hwj TUI 交互模式验证方法：`timeout 8 script -qc "DUAL_AGENT_MOCK=1 <隔离env> node hwj/hwj.js" /dev/null < <(sleep 5; printf '任务\n'; sleep 2)` 分配伪 TTY 模拟双击终端；批处理 e2e 用 `--script "消息"`（非 TTY 自动降级 plain 输出）。
  - 测试 hwj/core.js（模块顶层有 DATA_DIR 常量）必须先 `process.env.DUAL_AGENT_DATA=...` 再 require——ENV 对象只传子进程不生效，晚设会污染真实 .data/（踩过：hwj-state.json 写进真仓，需 git status 确认 untracked 后移走）。
- Category: Project Knowledge (Architecture)
- Instructions:
  - hwj 架构：hwj/ 四文件（tui 渲染/core 编排/commands 命令/hwj 入口）require 复用 lib/inner+lib/plugins+lib/llmRetry，零改动 server/lib/plugins；会话独立 workspaces/<ws>/hwj-messages.json，配置共享 .data/config.json，process.md/inner-log.jsonl/inner-usage.json 与 server 同格式 append 共存。
  - core.js 复刻 server handleInnerChat 的注意点：chatInnerReal 的 opts 无 readonly/abortCheck——plan 拦截与 SIGINT 中断都在 callPlugin 包装层做（工具调用边界抛 HwjAbortError，配对完整性天然保证）；意图抽取 hwj 比 server 更进一步（框架主动 extract，MOCK 下跳过）；活动区 reply 只是流式预览，最终交付文本以 core 返回的 finalText 为准（含核验缺口标注后处理），endTask 只沉降工具行。
  - hwj.bat 路径解析顺序：HWJ_HOME 环境变量 → wslpath -a 映射 bat 所在目录 → 常见路径兜底探测（~/dual-agent 等）；启动用 `wsl.exe -e bash -lc "cd && exec node hwj/hwj.js"`（exec 让 Ctrl+C 直达 node）。
