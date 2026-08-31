// 数据存储：纯 JSON 文件，零依赖
// 文件位于数据目录（默认 <root>/.data），任务与消息持久化
// 损坏保护与原子写由 safejson 公共层提供：损坏文件备份 .corrupt-* 后只读，防覆盖丢数据
const fs = require('fs');
const path = require('path');
const safejson = require('./safejson');

// 数据目录基准：单文件 exe（构建时 --define 注入 AGENTS_CHAT_STANDALONE=1）= exe 所在目录（便携，数据随身）；
// 源码/npm 运行 = 项目根目录。AGENTS_CHAT_DATA 显式指定时优先。
let ROOT;
if (process.env.AGENTS_CHAT_STANDALONE === '1' && process.execPath) ROOT = path.dirname(process.execPath);
else ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.AGENTS_CHAT_DATA || path.join(ROOT, '.data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json'); // 旧版单文件（启动时一次性迁移到 messages/ 分片）
const MSG_DIR = path.join(DATA_DIR, 'messages');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');
const OC_SESSIONS_PATH = path.join(DATA_DIR, 'oc-sessions.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  return safejson.readJson(file, fallback);
}

function writeJson(file, data) {
  ensureDir();
  safejson.writeJson(file, data);
}

// ---------- 内置管家智能体（不可修改、不可删除，始终置顶） ----------
const BUTLER = {
  id: 'butler',
  name: '管家',
  locked: true,
  behavior: 'butler', // 仅演示模式生效
  model: '',
  icon: '🎩',
  desc: '内置调度智能体：理解需求、拆解任务、调度子智能体并行/串行执行并汇总交付',
  systemPrompt: '你是「管家」，Agents 群聊的内置总调度。用户未点名智能体的消息由你负责：理解需求、制定调度方案、指挥子智能体完成工作并向用户汇总交付。最终交付时先给出简明的结果概要，如有成果文件必须明确告知完整路径。与用户沟通使用简体中文，简洁、专业、有进展感。'
};

// ---------- 默认配置 ----------
// 统一 OpenCode 内核；每个实例 = persona + model + 独立会话
// behavior 仅在演示模式（AGENTS_CHAT_MOCK=1）下生效
function defaultConfig() {
  return {
    defaultAgent: '',
    globalCwd: '',
    kernel: 'auto', // 执行内核：'auto' 按检测顺序自动，或 opencode/claude/codex/pi
    agents: [
      BUTLER,
      {
        id: 'ag-eng',
        name: '工程师',
        behavior: 'worker-good',
        model: '',
        icon: '🧑‍💻',
        desc: '软件开发：写代码、修 bug、重构、技术方案评估',
        systemPrompt: '你是资深软件工程师。直接给出可靠的实现方案与代码，结果需可直接使用。用中文回复。'
      },
      {
        id: 'ag-rs',
        name: '研究员',
        behavior: 'echo',
        model: '',
        icon: '🔍',
        desc: '信息检索：联网查资料、阅读文件、调研并汇总要点',
        systemPrompt: '你是信息研究员。善于联网检索、阅读文件并汇总要点，结论需注明依据。用中文回复。'
      },
      {
        id: 'ag-wr',
        name: '文案',
        behavior: 'echo',
        model: '',
        icon: '✍️',
        desc: '文字工作：文章、报告、翻译、润色',
        systemPrompt: '你是专业写手。文字流畅、结构清晰、符合中文表达习惯。用中文回复。'
      }
    ]
  };
}

function getConfig() {
  let cfg = readJson(CONFIG_PATH, null);
  if (!cfg || !Array.isArray(cfg.agents)) {
    cfg = defaultConfig();
    try { writeJson(CONFIG_PATH, cfg); } catch { /* config 处于损坏保护：本次运行用默认配置，文件保留待人工恢复 */ }
  }
  // 管家始终置顶且使用内置定义（保证内置人设更新后自动生效）
  cfg.agents = [BUTLER, ...cfg.agents.filter(a => a && a.id !== 'butler')];
  cfg.defaultAgent = ''; // 已废弃：未点名消息一律由管家调度，兼容旧配置强制清空
  return cfg;
}

function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
}

// 保存用户自定义的子智能体列表 + 全局统一工作目录 + 执行内核（管家由内置定义补充，不接受传入）
// 基于现有配置增量合并，保留 schedEnabled 等其他字段不被覆盖丢失
function saveAgents(userAgents, globalCwd, kernel, approval) {
  const cfg = getConfig();
  saveConfig({
    ...cfg,
    defaultAgent: '',
    globalCwd: globalCwd !== undefined ? globalCwd : (cfg.globalCwd || ''),
    kernel: kernel !== undefined ? kernel : (cfg.kernel || 'auto'),
    approval: approval !== undefined ? approval : (cfg.approval || ''),
    agents: [BUTLER, ...userAgents]
  });
}

// 定时任务调度总开关（配置页侧栏「启动/关闭定时任务」按钮）
function getSchedEnabled() {
  return getConfig().schedEnabled !== false;
}
function setSchedEnabled(enabled) {
  const cfg = getConfig();
  saveConfig({ ...cfg, schedEnabled: !!enabled });
}

function getAgents() {
  return getConfig().agents;
}

// ---------- 团队仓库：经典智能体团队预设，一键应用 ----------
// 取材自开源社区验证过的经典组合：
// - 软件开发团队：MetaGPT / ChatDev 的「虚拟软件公司」流水线（产品→架构→工程→测试）
// - 内容创作团队：CrewAI 内容营销经典（研究→写作→编辑）
// - 深度调研团队：CrewAI 官方 Research Crew（检索→分析报告）
// - 翻译校对团队：CrewAI 入门经典（翻译→审校）
// 应用 = 写入子智能体名单（管家仍为内置调度者，相当于团队 Supervisor）
const TEAM_PRESETS = [
  {
    id: 'plan-exec-verify',
    name: '规划·执行·核验',
    icon: '🧩',
    source: '通用任务编排经典三角色（规划 → 执行 → 核验）',
    desc: '最精简的闭环工作流：规划者先把「怎么做」想清楚并产出方案，执行者按方案落地交付，核验者对照目标与计划验收把关。三者按需接力，适合绝大多数需要「先想清、再做、最后查」的任务。',
    usage: '例：「帮我把这个需求落地成一个可运行方案并验证」',
    agents: [
      {
        name: '规划者', icon: '🧭',
        desc: '方案设计：把目标拆成可执行步骤，明确怎么做',
        systemPrompt: '你是规划者。面对用户的目标，你负责「确定怎么做」：先澄清模糊点，再把目标分解为有序、可执行的步骤（每个步骤的目标、产出、验收标准、依赖关系清晰），标明关键风险与取舍，给出推荐的技术/工具与里程碑。你只产出方案与计划，不写最终交付物本身；计划要具体到执行者能照做。用中文回复。'
      },
      {
        name: '执行者', icon: '🧑‍💻',
        desc: '具体实施：按规划落地，产出真实成果',
        systemPrompt: '你是执行者。严格遵循规划者给出的方案与步骤落地实施：产出真实、完整、可运行或可用的成果（代码、文档、产物等），关键决策符合规划；遇到计划未覆盖的情况在范围内合理处置并明确标注。交付前自检成果是否满足验收标准。用中文说明实现要点与产出位置。'
      },
      {
        name: '核验者', icon: '✅',
        desc: '验收核验：对照目标与计划核查成果是否达标',
        systemPrompt: '你是核验者。对照原始目标与规划者的计划，逐项核验执行者交付的成果：是否达成目标、是否满足验收标准、有无遗漏或偏差或错误。给出明确的「通过 / 不通过」结论；不通过时列出具体问题与最小修改建议，可要求执行者返工。结论必须基于事实核查，不轻信自述。用中文回复。'
      }
    ]
  },
  {
    id: 'software-dev',
    name: '软件开发团队',
    icon: '🏗️',
    source: 'MetaGPT / ChatDev「虚拟软件公司」',
    desc: '从一句话需求到可运行软件的经典流水线：产品经理写需求文档，架构师做系统设计，工程师编码实现，测试工程师验收把关。适合做工具、脚本、小型应用。',
    usage: '例：「帮我做一个记账小工具」',
    agents: [
      {
        name: '产品经理', icon: '🧭',
        desc: '需求分析：把想法变成结构化需求文档（PRD）',
        systemPrompt: '你是资深产品经理。把用户需求转化为清晰的需求文档：目标用户、核心功能列表（按优先级）、每个功能的用户故事与验收标准、边界与约束。输出结构化、可执行的 PRD，不做技术设计。善于向用户澄清模糊需求。用中文回复。'
      },
      {
        name: '架构师', icon: '📐',
        desc: '系统设计：技术选型、模块划分、接口与数据结构',
        systemPrompt: '你是资深软件架构师。基于需求文档做系统设计：技术选型（优先简单成熟方案）、模块划分、核心接口定义、数据结构、目录结构与关键实现思路。设计要具体到工程师可直接照做，避免空泛。用中文回复。'
      },
      {
        name: '工程师', icon: '🧑‍💻',
        desc: '编码实现：写出可直接运行的完整代码并调试',
        systemPrompt: '你是资深软件工程师。按照系统设计编写完整、可直接运行的代码：文件路径清晰、依赖最小化、关键逻辑有注释、边界情况有处理。遇到报错要实际调试修复而非绕过，交付前自行检查代码可运行。用中文说明实现要点。'
      },
      {
        name: '测试工程师', icon: '🧪',
        desc: '质量把关：写测试用例、执行测试、找缺陷',
        systemPrompt: '你是资深测试工程师。基于需求与实现编写测试用例（正常路径、边界、异常），实际执行测试并如实报告结果，不放过任何缺陷；发现的问题给出最小复现步骤与修复建议。验收结论必须基于事实而非自述。用中文回复。'
      }
    ]
  },
  {
    id: 'content-studio',
    name: '内容创作团队',
    icon: '✍️',
    source: 'CrewAI 内容营销经典组合',
    desc: '专业内容生产流水线：研究员收集素材与事实，作家撰写初稿，编辑审校润色与核查。适合公众号文章、营销文案、深度稿件、报告行文。',
    usage: '例：「写一篇关于远程办公利弊的文章」',
    agents: [
      {
        name: '研究员', icon: '🔍',
        desc: '素材收集：检索资料、核实事实、整理要点',
        systemPrompt: '你是信息研究员。围绕写作主题收集素材：核心事实与数据（注明来源）、正反方观点、典型案例、金句素材。输出结构化的素材清单供写作使用，事实必须核实，不确定的明确标注。用中文回复。'
      },
      {
        name: '作家', icon: '✍️',
        desc: '初稿撰写：结构清晰、有观点、有文采的成稿',
        systemPrompt: '你是专业作家。基于研究员的素材撰写成稿：抓人的开头、清晰的段落结构、明确的观点立场、有力的结尾。字数符合要求，风格适配目标读者，素材用得自然而不堆砌。用中文写作。'
      },
      {
        name: '编辑', icon: '📖',
        desc: '审校把关：事实核查、逻辑梳理、文字润色',
        systemPrompt: '你是资深编辑。对初稿做三件事：核查事实（数据、引述是否有依据）、梳理逻辑（结构、论证是否自洽）、润色文字（去冗余、改病句、统一术语与风格）。输出修改后的终稿并简要说明主要改动。用中文回复。'
      }
    ]
  },
  {
    id: 'research-crew',
    name: '深度调研团队',
    icon: '🔍',
    source: 'CrewAI 官方 Research Crew',
    desc: '两步调研法：研究员全面检索收集，分析师综合研判输出报告（摘要/洞察/趋势/建议）。适合技术选型、行业分析、竞品对比、决策支持。',
    usage: '例：「调研 2026 年主流前端框架该怎么选」',
    agents: [
      {
        name: '研究员', icon: '🔍',
        desc: '全面检索：多来源收集信息并交叉验证',
        systemPrompt: '你是信息研究员。对调研主题做全面检索：现状、主流方案/观点、关键数据、优劣势对比、近期变化。多来源交叉验证，每个结论标注依据来源，冲突信息如实呈现。输出结构化的调研材料。用中文回复。'
      },
      {
        name: '分析师', icon: '📊',
        desc: '综合研判：把材料提炼成有结论的分析报告',
        systemPrompt: '你是资深分析师。基于调研材料输出专业分析报告：执行摘要（3~5 句）、关键发现（编号列出）、趋势判断、风险提示、明确可执行的建议（含适用条件）。有数据用数据，没数据不编造，结论要敢下但注明置信度。用中文回复。'
      }
    ]
  },
  {
    id: 'translation-duo',
    name: '翻译校对团队',
    icon: '🌐',
    source: 'CrewAI 入门经典：翻译员 + 校对员',
    desc: '双人精翻组合：翻译员忠实原文完成初译，审校员核对语义、统一术语、润色表达。适合文档、合同、论文等对准确性要求高的文本。',
    usage: '例：「把这段产品介绍翻译成英文：<粘贴文本>」',
    agents: [
      {
        name: '翻译员', icon: '🌐',
        desc: '初译：忠实原文、保留术语、格式对应',
        systemPrompt: '你是专业译者。忠实翻译原文：不增删信息、专有名词查证后翻译并首次出现附原文、保持原文格式（段落/列表/代码块）。译不出把握的句子标注疑问而非硬翻。目标语言按任务要求，默认中英互译。'
      },
      {
        name: '审校员', icon: '⚖️',
        desc: '审校：语义核对、术语统一、表达润色',
        systemPrompt: '你是资深审校。逐句核对译文与原文语义是否一致，检查术语前后统一、数字单位准确、语句地道自然。输出终稿，并附「审校说明」：术语表、主要改动点、存疑处。用中文说明，译文保持目标语言。'
      }
    ]
  },
  {
    id: 'company-ops',
    name: '公司经营团队',
    icon: '🏢',
    source: '分工模式经典配置：模拟公司关键岗位协作',
    desc: '模拟公司四大关键岗位：财务经理管预算与成本、销售经理管客户与订单、生产经理管交付与质量、研发经理管产品与技术。配合「🤝 分工」模式使用：一句话下达经营议题，各经理并行开展自己职责内的部分，工作中可互相 @ 要数据要反馈。',
    usage: '例：「下季度我们要推一款新产品，请各部门给出自己的计划与需要的支持」',
    agents: [
      {
        name: '财务经理', icon: '💰',
        desc: '预算与成本：资金安排、费用测算、投入产出评估',
        systemPrompt: '你是公司财务经理。围绕经营议题负责财务视角：预算测算、成本结构、资金安排、投入产出与风险评估。输出具体数字与依据（可合理假设并注明），明确你需要哪些部门提供什么数据。用中文回复，条理清晰。'
      },
      {
        name: '销售经理', icon: '📈',
        desc: '客户与订单：市场策略、定价建议、销售目标',
        systemPrompt: '你是公司销售经理。围绕经营议题负责市场与销售视角：目标客户与市场策略、定价与促销建议、销售目标与渠道安排。输出可执行的销售计划，需要产品或交付支持时明确列出。用中文回复，条理清晰。'
      },
      {
        name: '生产经理', icon: '🏭',
        desc: '交付与质量：产能排期、供应链、质量控制',
        systemPrompt: '你是公司生产经理。围绕经营议题负责交付视角：产能与排期、供应链与物料、质量控制与交付节点。输出可落地的生产安排，需要研发或销售输入时明确列出。用中文回复，条理清晰。'
      },
      {
        name: '研发经理', icon: '🔬',
        desc: '产品与技术：方案设计、技术选型、研发排期',
        systemPrompt: '你是公司研发经理。围绕经营议题负责产品与技术视角：技术方案与选型、研发排期与人力、技术风险。输出可执行的研发计划，需要其他部门数据支持时可在回复中 @ 对方经理提问。用中文回复，条理清晰。'
      }
    ]
  }
];

function getTeamPresets() {
  return TEAM_PRESETS;
}

// ---------- 分工职工仓库预设（典型专职角色组合） ----------
const STAFF_PRESETS = [
  {
    id: 'startup', name: '互联网创业团队', icon: '🚀',
    desc: '产品经理、前后端开发、设计、测试、运营——最小可上线团队',
    usage: '产品立项 / 功能迭代 / 上线发布流程',
    staff: [
      { name: '产品经理', icon: '📋', role: '规划', desc: '需求分析、优先级排序、功能验收与上线节奏把控' },
      { name: '前端工程师', icon: '💻', role: '研发', desc: 'Web/小程序/APP 界面实现与交互逻辑，输出可运行的前端页面' },
      { name: '后端工程师', icon: '⚙️', role: '研发', desc: 'API 设计、数据库建模、业务逻辑实现、部署与性能调优' },
      { name: 'UI 设计师', icon: '🎨', role: '设计', desc: '视觉规范、界面原型、图标与动效，产出可直接交付前端的设计稿说明' },
      { name: '测试工程师', icon: '🔍', role: '质量', desc: '用例设计、边界与异常测试、性能与安全基线检查，输出问题清单' },
      { name: '运营专员', icon: '📢', role: '增长', desc: '用户获取策略、内容分发渠道、数据指标与 A/B 实验建议' }
    ]
  },
  {
    id: 'content', name: '内容创作团队', icon: '✍️',
    desc: '市场调研、文案策划、新媒体运营、视频剪辑、数据分析——内容流水线',
    usage: '品牌内容生产 / 营销战役 / 自媒体矩阵',
    staff: [
      { name: '市场调研员', icon: '🔎', role: '调研', desc: '竞品分析、热点趋势、用户画像；输出结构化调研报告' },
      { name: '文案策划', icon: '🖋️', role: '文案', desc: '内容选题、脚本撰写、标题优化，产出可直接发布的图文/短视频文案' },
      { name: '新媒体运营', icon: '📱', role: '运营', desc: '多平台分发策略、排期与互动管理、爆款拆解与复盘' },
      { name: '视频剪辑师', icon: '🎬', role: '制作', desc: '素材整理、剪辑节奏与包装、字幕字幕校对，输出成片' },
      { name: '数据分析师', icon: '📊', role: '数据', desc: '阅读量、完播率、转化率等核心指标监控；输出数据看板与优化建议' }
    ]
  },
  {
    id: 'ecom', name: '电商运营团队', icon: '🛒',
    desc: '选品、美工、客服、投放、供应链——完整电商链路',
    usage: '店铺运营 / 大促筹备 / 新品上市',
    staff: [
      { name: '选品专员', icon: '🧭', role: '选品', desc: '品类调研、竞品价格、利润测算与 SKU 规划' },
      { name: '视觉美工', icon: '🖼️', role: '设计', desc: '主图、详情页、活动海报视觉产出，输出设计规范与切图描述' },
      { name: '客服主管', icon: '💬', role: '服务', desc: '话术库建设、售后流程、评价管理与 NPS 提升' },
      { name: '投放优化师', icon: '🎯', role: '投放', desc: '信息流/搜索广告账户搭建、人群定向、出价策略与 ROI 优化' },
      { name: '供应链专员', icon: '📦', role: '供应链', desc: '供应商对接、库存计划、发货时效与成本控制' }
    ]
  },
  {
    id: 'enterprise', name: '企业职能团队', icon: '🏛️',
    desc: '财务、人事、行政、法务、销售——大型企业标配',
    usage: '内部流程设计 / 制度修订 / 组织效能提升',
    staff: [
      { name: '财务专员', icon: '💰', role: '财务', desc: '预算编制、成本核算、税务筹划、财务风险预警' },
      { name: '人事专员', icon: '👥', role: '人力', desc: '招聘面试、培训体系、绩效方案、员工关系与激励' },
      { name: '行政专员', icon: '📂', role: '行政', desc: '办公资源统筹、会议组织、固定资产与合同档案管理' },
      { name: '法务顾问', icon: '⚖️', role: '法务', desc: '合同审查、合规风控、知识产权与劳动争议预防' },
      { name: '销售经理', icon: '🤝', role: '销售', desc: '客户开发、商务谈判、渠道管理与销售目标拆解' }
    ]
  },
  {
    id: 'tech', name: '技术研发团队', icon: '⚡',
    desc: '架构、算法、开发、运维、安全——完整技术栈',
    usage: '系统重构 / 新技术引入 / 性能优化',
    staff: [
      { name: '架构师', icon: '🏗️', role: '架构', desc: '技术选型、系统分层与接口设计、性能与扩展性方案' },
      { name: '算法工程师', icon: '🧠', role: '算法', desc: '模型选型与训练、特征工程、A/B 验证与在线评估' },
      { name: '后端工程师', icon: '🔧', role: '开发', desc: '业务接口、数据层、消息队列与分布式服务实现' },
      { name: '运维工程师', icon: '🛠️', role: '运维', desc: 'CI/CD 管道、监控告警、容量规划与故障应急' },
      { name: '安全顾问', icon: '🔒', role: '安全', desc: '安全基线、漏洞扫描、权限设计与隐私合规建议' }
    ]
  }
];

function getStaffPresets() {
  return STAFF_PRESETS;
}

// ---------- 任务列表 ----------
// seq 决定执行/显示顺序（拖拽可改）；createdAt 仅用于展示时间
// assign：任务末尾 @智能体 指派（agentId）；空 = 管家调度；子智能体 = 独立完成
function getTasks() {
  const tasks = readJson(TASKS_PATH, []);
  return tasks.slice().sort((a, b) => {
    const sa = a.seq === undefined ? Number.MAX_SAFE_INTEGER : a.seq;
    const sb = b.seq === undefined ? Number.MAX_SAFE_INTEGER : b.seq;
    return sa === sb ? a.createdAt - b.createdAt : sa - sb;
  });
}

function saveTasks(tasks) {
  writeJson(TASKS_PATH, tasks);
}

// 从文本提取任务：
// mode='sequential'（顺序任务）：每行一个任务，仅支持「1.」编号格式，行末可 @智能体 指派
// mode='scheduled'（定时任务）：行首时间 = 定时启动时间，
//   支持完整日期（20260818-1307 / 2026-08-18 13:07）与当天时刻（13:07），行末可 @智能体
// runner='solo' 时任务标记为单聊执行（由 opencode 单体完成，不经管家编排）
// 返回 {tasks, warnings}
function parseTasksFromText(text, mode, runner, model) {
  mode = mode === 'scheduled' ? 'scheduled' : 'sequential';
  const now = new Date();
  const baseTs = now.getTime();
  const parsed = [];
  const warnings = [];
  const agents = getAgents();
  let seq = 0;
  let fallbackIdx = 0;

  const validDate = (y, mo, d, h, mi) =>
    mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    // 行末 @指派
    let assign = '';
    const am = line.match(/\s*@([^\s@，。,；;]+)\s*$/);
    if (am) {
      const tok = am[1];
      line = line.slice(0, am.index).trim();
      const ag = agents.find(a => a.id === tok) || agents.find(a => a.name === tok);
      if (ag) assign = ag.id;
      else warnings.push(`@${tok} 不是已配置的智能体，任务「${line.slice(0, 20)}」将改由管家调度`);
    }

    let createdAt = null;
    let scheduledAt = null;
    let m;
    // 紧凑全日期格式：20260818-1307
    m = line.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\s+(.*)$/);
    if (m) {
      const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
      if (validDate(y, mo, d, h, mi)) {
        createdAt = scheduledAt = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
        line = m[6].trim();
      } else {
        warnings.push(`「${line.slice(0, 20)}」行首时间格式不合法（应为 20260818-1307），已按普通内容处理`);
      }
    }
    // 完整日期格式：2026-08-18 13:07[:30]
    if (createdAt === null) {
      m = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
      if (m) {
        const dt = new Date(`${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}:${m[4] || '00'}`);
        if (!isNaN(dt.getTime())) {
          createdAt = scheduledAt = dt.getTime();
          line = m[5].trim();
        }
      }
    }
    // 当天时刻：13:07（顺序模式仅作排序时间；定时模式作为当天定时启动时间）
    if (createdAt === null) {
      m = line.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)$/);
      if (m) {
        const d = new Date(now);
        d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
        createdAt = d.getTime();
        if (mode === 'scheduled') scheduledAt = createdAt;
        line = m[4].trim();
      }
    }

    // 列表符剥离：仅「1. / 1、 / 1)」编号格式（顺序与定时模式一致）
    // 单聊模式编号后空白可省略（1.写xxx 2.-xxx 3.//xxx）；群聊保持编号后须有空白
    const soloRun = runner === 'solo';
    line = line.replace(soloRun ? /^(\d+[.、)])\s*/ : /^(\d+[.、)])\s+/, '').trim();
    if (!line) continue;

    // 单聊执行链前缀（编号剥离后识别）：
    //   -    接续上一任务的会话继续执行（同一 opencode 进程续聊）
    //   //   并行执行：连续多个 // 任务各自独立进程同时跑
    //   无前缀 = 新会话独立执行（默认）
    let link = 'new';
    if (soloRun) {
      if (/^\/\//.test(line)) { link = 'parallel'; line = line.replace(/^\/\/\s*/, ''); }
      else if (/^-/.test(line)) { link = 'continue'; line = line.replace(/^-\s*/, ''); }
      line = line.trim();
      if (!line) continue;
    }

    if (createdAt === null) {
      createdAt = baseTs + fallbackIdx * 1000;
      fallbackIdx++;
    }

    const rec = {
      id: `t-${baseTs}-${seq++}`,
      title: line.slice(0, 500),
      notes: '',
      createdAt,
      status: 'pending',
      assign,
      result: '',
      kind: mode,
      runner: runner === 'solo' ? 'solo' : ''
    };
    if (soloRun) rec.link = link; // new=独立新会话 | continue=接续上一任务会话 | parallel=并行独立会话
    if (mode === 'scheduled') rec.scheduledAt = scheduledAt !== null ? scheduledAt : createdAt;
    parsed.push(rec);
  }
  return { tasks: parsed, warnings };
}

function importTasks(text, mode, runner, model) {
  const { tasks: parsed, warnings } = parseTasksFromText(text, mode, runner);
  const tasks = getTasks();
  // 若存在无 seq 的旧任务，先按现有顺序（createdAt）补齐
  let next = 0;
  for (const t of tasks) { if (t.seq === undefined) t.seq = next++; else next = Math.max(next, t.seq + 1); }
  for (const t of parsed) { t.seq = next++; if (runner === 'solo' && model) t.model = String(model); }
  saveTasks(tasks.concat(parsed));
  return { added: parsed.length, warnings, addedTasks: parsed };
}

// 拖拽排序：按给定 id 顺序重编 seq（ids 应为全量，未包含的追加在末尾）
function reorderTasks(ids) {
  const sorted = getTasks();
  const order = [];
  const seen = new Set();
  for (const id of ids) { const t = sorted.find(x => x.id === id); if (t && !seen.has(id)) { order.push(t); seen.add(id); } }
  for (const t of sorted) if (!seen.has(t.id)) order.push(t);
  order.forEach((t, i) => { t.seq = i; });
  saveTasks(order);
}

// 删除任务及其会话消息（含新版分片；旧版单文件一并清理）
function deleteTask(id) {
  saveTasks(getTasks().filter(t => t.id !== id));
  writeJson(MESSAGES_PATH, readJson(MESSAGES_PATH, []).filter(m => (m.taskId || '') !== id));
  try { fs.unlinkSync(msgShardPath(id)); } catch { /* 分片不存在（旧数据/空任务）无需处理 */ }
  return true;
}

function updateTask(id, patch) {
  const tasks = getTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  saveTasks(tasks);
  return t;
}

// 孤儿状态修复：服务异常退出后仍标记 running 的任务复位为待执行
// 启动与退出时调用，避免任务永远卡在「执行中」
function resetRunningTasks() {
  const tasks = getTasks();
  let n = 0;
  for (const t of tasks) {
    if (t.status === 'running') { t.status = 'pending'; t.result = '服务重启，已复位为待执行'; n++; }
  }
  if (n > 0) saveTasks(tasks);
  return n;
}

function getTask(id) {
  return getTasks().find(x => x.id === id) || null;
}

// ---------- 消息（分片存储：messages/<key>.json，每个会话一个文件） ----------
// taskId 为空 = 主会话；否则属于对应任务/单聊会话
// 旧版全部消息集中在单个 messages.json：每条消息都要全量读写整个文件，历史越长 IO 越大；
// 分片后单会话读写只涉及自己的文件；旧文件在首次访问时一次性迁移（原件保留为 .migrated 备份）
let msgMigrated = false;
function migrateLegacyMessages() {
  if (msgMigrated) return;
  msgMigrated = true;
  let raw = null;
  try {
    raw = fs.readFileSync(MESSAGES_PATH, 'utf8');
  } catch { return; } // 无旧文件
  let all;
  try {
    all = JSON.parse(raw);
  } catch {
    // 旧文件损坏：备份现场后放弃迁移（各会话从空开始，原件可供人工恢复）
    try { fs.copyFileSync(MESSAGES_PATH, `${MESSAGES_PATH}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    console.error(`[store] 旧版 messages.json 损坏，已备份并跳过迁移：${MESSAGES_PATH}`);
    return;
  }
  if (!Array.isArray(all)) {
    try { fs.renameSync(MESSAGES_PATH, MESSAGES_PATH + '.migrated'); } catch { /* ignore */ }
    return;
  }
  const groups = new Map();
  for (const m of all) {
    const k = (m && m.taskId) || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  try {
    fs.mkdirSync(MSG_DIR, { recursive: true });
    for (const [k, list] of groups) writeJson(msgShardPath(k), list);
    fs.renameSync(MESSAGES_PATH, MESSAGES_PATH + '.migrated'); // 保留备份供人工核对
  } catch (err) {
    console.error('[store] messages 迁移失败（下次启动重试）:', err && err.message);
    msgMigrated = false;
  }
}

// 会话 key -> 分片文件名：常规 id 原样使用；其余（空/特殊字符）十六进制编码，避免文件名问题
function msgShardName(key) {
  const k = key == null ? '' : String(key);
  if (k === '') return '_main.json';
  if (/^[A-Za-z0-9_-]{1,80}$/.test(k)) return k + '.json';
  return '~' + Buffer.from(k).toString('hex').slice(0, 160) + '.json';
}
function msgShardPath(key) { return path.join(MSG_DIR, msgShardName(key)); }

function getMessages(taskId) {
  migrateLegacyMessages();
  if (taskId === undefined) {
    // 全量视图：合并所有分片，按时间排序还原全局顺序
    let files = [];
    try { files = fs.readdirSync(MSG_DIR); } catch { return []; }
    const all = [];
    for (const name of files) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const list = readJson(path.join(MSG_DIR, name), []);
      if (Array.isArray(list)) all.push(...list);
    }
    all.sort((a, b) => ((a && a.timestamp) || '') < ((b && b.timestamp) || '') ? -1 : 1);
    return all;
  }
  const list = readJson(msgShardPath(String(taskId)), []);
  return Array.isArray(list) ? list : [];
}

// 单会话消息上限：防止定时任务长跑数月将会话分片膨胀到读写不可承受
// 默认 500 条，AGENTS_CHAT_MSG_LIMIT 可调（0 = 不限制）；主会话豁免（已有 epoch + 过期清理机制）
const MSG_LIMIT = (() => {
  const n = Number(process.env.AGENTS_CHAT_MSG_LIMIT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 500;
})();

function addMessage(msg) {
  migrateLegacyMessages();
  fs.mkdirSync(MSG_DIR, { recursive: true });
  const key = msg.taskId || '';
  const msgs = readJson(msgShardPath(key), []);
  // 主会话消息记录所属 epoch：新会话开启后，旧 epoch 消息不再传入上下文
  const rec = {
    id: msg.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: msg.role,
    content: msg.content,
    agentId: msg.agentId || '',
    agentName: msg.agentName || '',
    phase: msg.phase || '',
    actor: msg.actor || '',
    taskId: msg.taskId || '',
    plan: msg.plan || undefined,
    outputPath: msg.outputPath || '',
    epoch: msg.taskId ? undefined : (msg.epoch !== undefined ? msg.epoch : (Number(getConfig().mainEpoch) || 0)),
    timestamp: msg.timestamp || new Date().toISOString()
  };
  msgs.push(rec);
  // 滚动清理：超上限裁掉最旧消息，开头留一条系统标记说明去向（标记本身也会随时间被裁）
  if (key !== '' && MSG_LIMIT > 0 && msgs.length > MSG_LIMIT) {
    const kept = msgs.slice(msgs.length - MSG_LIMIT);
    const first = kept[0];
    if (!(first && first.role === 'sys' && /已按上限自动清理/.test(String(first.content || '')))) {
      kept.unshift({ role: 'sys', content: `（已达单会话消息上限 ${MSG_LIMIT} 条，更早的过程消息已自动滚动清理，任务结果以最终结果区为准）`, taskId: key, timestamp: new Date().toISOString() });
    }
    msgs.length = 0;
    msgs.push(...kept);
  }
  writeJson(msgShardPath(key), msgs);
  // 用量统计：消息携带 usage（token 数）即累计——所有 runner 的消息路径统一经过这里
  const u = Number(msg.usage);
  if (u > 0) recordUsage({ tokens: Math.floor(u), requests: 1 });
}

// ---------- 全历史关键词检索：逐分片匹配，不合并大数组 ----------
function searchMessages(q, { limit = 50 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  let files = [];
  try { files = fs.readdirSync(MSG_DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let list;
    try { list = readJson(path.join(MSG_DIR, f), []); } catch { continue; }
    if (!Array.isArray(list)) continue;
    // 分片名还原会话标识（hex 编码逆变换，_main 为主会话）
    const stem = f.replace(/\.json$/, '');
    const sessionId = stem === '_main' ? '' : (stem.startsWith('_') ? Buffer.from(stem.slice(1), 'hex').toString('utf8') : stem);
    for (const m of list) {
      const c = String(m.content || '');
      if (c.toLowerCase().includes(needle)) {
        const idx = c.toLowerCase().indexOf(needle);
        const from = Math.max(0, idx - 40);
        out.push({
          sessionId, role: m.role || '', agentName: m.agentName || '',
          snippet: (from > 0 ? '…' : '') + c.slice(from, from + needle.length + 80) + '…',
          timestamp: m.timestamp || ''
        });
        if (out.length >= limit * 3) break; // 分片内粗截，最后统一排序取 limit
      }
    }
  }
  out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return out.slice(0, limit);
}

// ---------- 用量统计（token/请求数按日累计，usage.json） ----------
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
function readUsage() {
  const d = readJson(USAGE_PATH, { days: {}, total: { tokens: 0, requests: 0 } });
  if (!d.days) d.days = {};
  if (!d.total) d.total = { tokens: 0, requests: 0 };
  return d;
}
function recordUsage({ tokens = 0, requests = 0 } = {}) {
  const d = readUsage();
  const day = new Date().toISOString().slice(0, 10);
  if (!d.days[day]) d.days[day] = { tokens: 0, requests: 0 };
  d.days[day].tokens += Math.floor(tokens);
  d.days[day].requests += Math.floor(requests);
  d.total.tokens += Math.floor(tokens);
  d.total.requests += Math.floor(requests);
  // 只保留最近 60 天明细，总量恒累计
  const days = Object.keys(d.days).sort();
  while (days.length > 60) delete d.days[days.shift()];
  writeJson(USAGE_PATH, d);
}
function getUsageStats() {
  const d = readUsage();
  const today = new Date().toISOString().slice(0, 10);
  const recent = Object.entries(d.days).slice(-7).map(([day, v]) => ({ day, ...v }));
  return { today: d.days[today] || { tokens: 0, requests: 0 }, total: d.total, recent };
}

// ---------- 数据目录占用统计（可见性：让用户看得到空间去哪了） ----------
function dirSize(p) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const fp = path.join(p, e.name);
    try {
      if (e.isDirectory()) total += dirSize(fp);
      else total += fs.statSync(fp).size;
    } catch { /* ignore */ }
  }
  return total;
}
function dataStats() {
  const parts = {};
  for (const name of ['messages', 'outputs', 'workspace', 'flow']) {
    parts[name] = dirSize(path.join(DATA_DIR, name));
  }
  return { total: dirSize(DATA_DIR), ...parts };
}

// 按会话统计消息数（逐分片累加，不合并大数组：统计/导出场景低内存）
function countMessagesByTask() {
  migrateLegacyMessages();
  const counts = {};
  let main = 0;
  let files = [];
  try { files = fs.readdirSync(MSG_DIR); } catch { return { counts, main }; }
  for (const name of files) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let list;
    try { list = JSON.parse(fs.readFileSync(path.join(MSG_DIR, name), 'utf8')); } catch { continue; }
    if (!Array.isArray(list) || !list.length) continue;
    const tid = list[0].taskId || '';
    if (tid) counts[tid] = (counts[tid] || 0) + list.length;
    else main += list.length;
  }
  return { counts, main };
}

function clearMessages() {
  migrateLegacyMessages();
  // 清空全部会话消息：删除所有分片，主会话分片重置为空数组
  try {
    for (const name of fs.readdirSync(MSG_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      try { fs.unlinkSync(path.join(MSG_DIR, name)); } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 */ }
  writeJson(msgShardPath(''), []);
}

// ---------- 流转日志（智能体之间的派发/交接/返工/验收事件，append-only） ----------
// 供「🔭 流转」页面绘制泳道时间线：谁在何时把什么信息交给了谁
const FLOW_PATH = path.join(DATA_DIR, 'flow.jsonl');

function addFlowEvent(ev) {
  try {
    ensureDir();
    const rec = {
      t: ev.t || new Date().toISOString(),
      run: String(ev.run || '').slice(0, 60),
      type: String(ev.type || ''),       // start|plan|dispatch|done|handoff|rework|verify|finish
      from: String(ev.from || '').slice(0, 40),
      to: String(ev.to || '').slice(0, 40),
      stage: Number(ev.stage) || 0,
      round: Number(ev.round) || 0,
      summary: String(ev.summary || '').slice(0, 400),
      files: Array.isArray(ev.files) ? ev.files.slice(0, 20).map(f => String(f).slice(0, 300)) : [],
      detail: ev.detail && typeof ev.detail === 'object' ? ev.detail : {}
    };
    // 原子追加：tmp+rename 避免进程中断留下半截行（JSONL 格式单行即一条完整记录）
    const recLine = JSON.stringify(rec) + '\n';
    const tmpFlow = FLOW_PATH + '.tmp';
    fs.writeFileSync(tmpFlow, recLine, 'utf8');
    fs.renameSync(tmpFlow, FLOW_PATH);
    return rec;
  } catch { return null; }
}

function readFlowAll() {
  try {
    return fs.readFileSync(FLOW_PATH, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// 单次编排的全部事件（按时间序）
function getFlow(runId) {
  return readFlowAll().filter(e => e.run === runId);
}

// 最近编排列表：run id 去重 + 元信息（开始时间/事件数/参与者/是否结束）
function listFlowRuns(limit) {
  const all = readFlowAll();
  const map = new Map(); // run -> 元信息
  for (const e of all) {
    let r = map.get(e.run);
    if (!r) { r = { run: e.run, start: e.t, end: '', events: 0, agents: new Set(), finished: false, summary: '' }; map.set(e.run, r); }
    r.events++;
    r.end = e.t;
    if (e.from) r.agents.add(e.from);
    if (e.to) r.agents.add(e.to);
    if (e.type === 'finish') { r.finished = true; r.summary = e.summary; }
    if (e.type === 'start' && !r.summary) r.summary = e.summary;
  }
  return [...map.values()]
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .slice(0, limit || 30)
    .map(r => ({ ...r, agents: [...r.agents] }));
}

// ---------- 单聊工作台（OpenCode）会话 ----------
// 每个网页会话对应一条记录：ocSessionId 为 opencode 的 ses_xxx（首次运行后回填，-s 续聊）
// 聊天消息复用 messages.json（taskId = oc 会话 id），导出/清空历史自动生效
function getOcSessions() {
  const d = readJson(OC_SESSIONS_PATH, null);
  const list = Array.isArray(d && d.sessions) ? d.sessions : [];
  return list
    .filter(s => s && s.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveOcSessions(list) {
  writeJson(OC_SESSIONS_PATH, { sessions: list });
}

// 新建或增量更新（patch 覆盖，updatedAt 自动刷新）
function upsertOcSession(id, patch) {
  const list = getOcSessions();
  let rec = list.find(s => s.id === id);
  if (!rec) {
    rec = { id, title: '', ocSessionId: '', model: '', createdAt: Date.now(), updatedAt: Date.now() };
    list.push(rec);
  }
  Object.assign(rec, patch || {}, { id, updatedAt: Date.now() });
  saveOcSessions(list);
  return rec;
}

function getOcSession(id) {
  return getOcSessions().find(s => s.id === id) || null;
}

function deleteOcSession(id) {
  saveOcSessions(getOcSessions().filter(s => s.id !== id));
  try { fs.unlinkSync(msgShardPath(id)); } catch { /* 分片不存在 */ }
}

// ---------- 分工模式 opencode 会话（成员工作记忆） ----------
// 同一聊天会话（taskId，主会话为 'main'）内每个成员复用同一 opencode 会话：
// 多段工作（初始/响应/唤醒）与跨消息轮次都续用，成员保持完整工作记忆
const DIVIDE_SESSIONS_PATH = path.join(DATA_DIR, 'divide-sessions.json');

function getDivideSessions() {
  const d = readJson(DIVIDE_SESSIONS_PATH, null);
  const map = d && typeof d.sessions === 'object' && !Array.isArray(d.sessions) ? d.sessions : {};
  return map;
}

// taskKey：taskId 或 'main'；返回 { agentId: ocSessionId }（损坏/缺失返回空对象）
function getDivideSessionMap(taskKey) {
  const all = getDivideSessions();
  const m = all[taskKey];
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// 增量合并写入（只更新出现的键；sessionId 为空删除该键），原子落盘
function saveDivideSessions(taskKey, agentSessions) {
  const all = getDivideSessions();
  const cur = all[taskKey] && typeof all[taskKey] === 'object' && !Array.isArray(all[taskKey]) ? all[taskKey] : {};
  for (const [agentId, ses] of Object.entries(agentSessions || {})) {
    if (ses) cur[agentId] = String(ses); else delete cur[agentId];
  }
  all[taskKey] = cur;
  writeJson(DIVIDE_SESSIONS_PATH, { sessions: all });
}

// 清空某个聊天会话的分工会话记录（会话删除时联动）
function clearDivideSessions(taskKey) {
  const all = getDivideSessions();
  if (!(taskKey in all)) return;
  delete all[taskKey];
  writeJson(DIVIDE_SESSIONS_PATH, { sessions: all });
}

// ---------- 管家长期记忆（跨会话偏好与教训，读写由 memory.js 负责） ----------
function getMemoryData() {
  const d = readJson(MEMORY_PATH, null);
  return {
    memory: Array.isArray(d && d.memory) ? d.memory.map(s => String(s)).filter(Boolean) : [],
    user: Array.isArray(d && d.user) ? d.user.map(s => String(s)).filter(Boolean) : []
  };
}
function saveMemoryData(data) {
  writeJson(MEMORY_PATH, {
    memory: Array.isArray(data.memory) ? data.memory.map(String) : [],
    user: Array.isArray(data.user) ? data.user.map(String) : []
  });
}

// ---------- 历史数据清理（工作产生的动态文件与历史记录，超期自动/手动清理） ----------
// 清理范围：已完结任务 + 任务消息 + 过期主会话消息 + 过期单聊会话 + 产出存档 outputs/ + 流转日志
// 保留：未完结/待触发任务、管家记忆（memory 是长期记忆，不属于历史记录）、config
// 返回 { tasks, messages, ocSessions, outputs, flowEvents } 各项清理计数
function pruneOldData(days) {
  const cutoff = Date.now() - Math.max(1, Number(days) || 15) * 24 * 3600 * 1000;
  const stat = { tasks: 0, messages: 0, ocSessions: 0, outputs: 0, flowEvents: 0 };
  const tsOf = (m) => { const t = Date.parse(m.timestamp || ''); return Number.isFinite(t) ? t : 0; };

  // 1. 已完结任务（done/failed）；pending/scheduled 一律保留（含未触发的定时任务）
  const tasks = getTasks();
  const keptTasks = tasks.filter(t => {
    const end = Number(t.updatedAt || t.createdAt) || 0;
    const finished = t.status === 'done' || t.status === 'failed';
    if (finished && end && end < cutoff) { stat.tasks++; return false; }
    return true;
  });
  if (stat.tasks) saveTasks(keptTasks);

  // 2. 单聊会话：updatedAt 超 cutoff → 删（连同其消息）
  const keptSess = getOcSessions().filter(s => {
    const u = Number(s.updatedAt || s.createdAt) || 0;
    if (u && u < cutoff) { stat.ocSessions++; return false; }
    return true;
  });
  if (stat.ocSessions) {
    saveOcSessions(keptSess);
    // 其消息由下方第 3 步统一按孤儿清理并计数（避免重复统计）
  }

  // 3. 消息（分片）：孤儿会话分片整文件删除；主会话分片按 timestamp 过滤
  const validIds = new Set([...keptTasks.map(t => t.id), ...keptSess.map(s => s.id)]);
  try {
    for (const name of fs.readdirSync(MSG_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const fp = path.join(MSG_DIR, name);
      let list;
      try { list = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; } // 损坏分片留给损坏保护处理
      if (!Array.isArray(list)) continue;
      const tid = list.length ? (list[0].taskId || '') : '';
      if (tid && !validIds.has(tid)) {
        // 孤儿会话（任务/单聊已删或超期）：整分片删除
        stat.messages += list.length;
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      } else if (!tid) {
        // 主会话：按时间过滤
        const kept = list.filter(m => !tsOf(m) || tsOf(m) >= cutoff);
        if (kept.length !== list.length) { stat.messages += list.length - kept.length; writeJson(fp, kept); }
      }
    }
  } catch { /* 无目录 */ }

  // 4. 流转日志：超期事件行过滤重写（e.t 为 ISO 字符串，需 Date.parse；解析失败的行顺带清除）
  try {
    const lines = fs.readFileSync(FLOW_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    const kept = lines.filter(l => {
      try { const e = JSON.parse(l); if ((Date.parse(e.t || '') || 0) < cutoff) { stat.flowEvents++; return false; } } catch { stat.flowEvents++; return false; }
      return true;
    });
    if (kept.length !== lines.length) {
      const tmpF = FLOW_PATH + '.tmp';
      fs.writeFileSync(tmpF, kept.length ? kept.join('\n') + '\n' : '');
      fs.renameSync(tmpF, FLOW_PATH);
    }
  } catch { /* 无文件 */ }

  // 5. 产出存档目录 outputs/<会话>/：mtime 超 cutoff → 删除
  const outputsDir = path.join(DATA_DIR, 'outputs');
  try {
    for (const name of fs.readdirSync(outputsDir)) {
      const fp = path.join(outputsDir, name);
      try {
        const st = fs.statSync(fp);
        if (st.isDirectory() && st.mtimeMs < cutoff) { fs.rmSync(fp, { recursive: true, force: true }); stat.outputs++; }
      } catch { /* 单项失败跳过 */ }
    }
  } catch { /* 无目录 */ }

  return stat;
 }

// ---------- 分工职工：独立于群聊智能体的专职角色库（财务/销售/研发/文案/调研员等） ----------
const STAFF_PATH = path.join(DATA_DIR, 'staff.json');
// 默认职工：仅一名调研员（用户按需扩充，AI 生成或手动添加）
const DEFAULT_STAFF = [
  { id: 'researcher', name: '调研员', icon: '🔍', desc: '负责信息检索、资料收集与事实核查，为团队提供数据与背景支撑', role: '调研' }
];

function getStaff() {
  const list = readJson(STAFF_PATH, null);
  if (Array.isArray(list)) return list.filter(s => s && s.id && s.name);
  try { writeJson(STAFF_PATH, DEFAULT_STAFF); } catch { /* 损坏保护：本次用默认 */ }
  return DEFAULT_STAFF.slice();
}

function saveStaff(list) {
  writeJson(STAFF_PATH, (Array.isArray(list) ? list : []).filter(s => s && s.id && s.name));
}

function upsertStaff(item) {
  const list = getStaff();
  const id = String(item && item.id || '').trim();
  const name = String(item && item.name || '').trim().slice(0, 40);
  if (!name) return null;
  const found = id ? list.find(s => s.id === id) : null;
  const entry = {
    id: found ? found.id : (id || 'staff-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name,
    icon: String(item.icon || '🧑‍💼').slice(0, 8),
    desc: String(item.desc || '').slice(0, 500),
    role: String(item.role || '职工').slice(0, 20)
  };
  if (found) Object.assign(found, entry);
  else list.push(entry);
  saveStaff(list);
  return entry;
}

function deleteStaff(id) {
  saveStaff(getStaff().filter(s => s.id !== id));
  return true;
}

module.exports = {
  DATA_DIR,
  BUTLER,
  getConfig,
  saveConfig,
  saveAgents,
  getSchedEnabled,
  setSchedEnabled,
  getMemoryData,
  saveMemoryData,
  getAgents,
  getStaff,
  saveStaff,
  upsertStaff,
  deleteStaff,
  getStaffPresets,
  getTeamPresets,
  getTasks,
  saveTasks,
  importTasks,
  reorderTasks,
  deleteTask,
  updateTask,
  resetRunningTasks,
  getTask,
  parseTasksFromText,
  getMessages,
  addMessage,
  clearMessages,
  countMessagesByTask,
  searchMessages,
  recordUsage,
  getUsageStats,
  dataStats,
  addFlowEvent,
  getFlow,
  listFlowRuns,
  getOcSessions,
  saveOcSessions,
  upsertOcSession,
  getOcSession,
  deleteOcSession,
  getDivideSessionMap,
  saveDivideSessions,
  clearDivideSessions,
  pruneOldData,
  getCorruptedFiles: () => safejson.corruptedFiles()
};
