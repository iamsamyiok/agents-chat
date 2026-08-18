// 演示模式 agent（仅 AGENTS_CHAT_MOCK=1 时启用，输出均为模拟结果）
// 行为由 MOCK_BEHAVIOR 环境变量控制，prompt 为 argv[2]
const stdout = process.stdout;
const behavior = process.env.MOCK_BEHAVIOR || 'echo';
const prompt = process.argv.slice(2).join(' ');
const DEMO_TAG = '（演示模式：模拟输出，未调用真实智能体。去掉 .env 中 AGENTS_CHAT_MOCK=1 并安装 OpenCode 后为真实执行）';

function output(text) {
  stdout.write(text + '\n');
  setTimeout(() => process.exit(0), 20);
}

function streamOutput(lines) {
  let i = 0;
  const tick = () => {
    if (i < lines.length) {
      stdout.write(lines[i] + '\n');
      i++;
      setTimeout(tick, 30);
    } else {
      process.exit(0);
    }
  };
  tick();
}

if (behavior === 'echo') {
  if (prompt.includes('【文件产出要求】')) {
    // 演示「成果文件」闭环：真实写入工作目录一个文件，输出末尾报告完整绝对路径
    const fs = require('fs');
    const path = require('path');
    const file = path.join(process.cwd(), 'demo-deliverable.md');
    fs.writeFileSync(file, '# 演示成果\n\n这是演示模式下智能体写入工作目录的成果文件。\n');
    output(`完成：任务已解决，成果文件已写入工作目录 ${DEMO_TAG}\n\n【产出文件】\n- ${file}`);
  } else {
    streamOutput([`[演示] 收到：${prompt.slice(0, 200)}`, '正在处理…', `完成 ${DEMO_TAG}`]);
  }
} else if (behavior === 'worker-good') {
  output(`完成：任务已解决，产出可用结果 ${DEMO_TAG}`);
} else if (behavior === 'worker-bad-then-good') {
  output(`改进：已根据反馈修复缺陷，现在结果合格 ${DEMO_TAG}`);
} else if (behavior === 'lead') {
  if (prompt.includes('规划')) {
    output(`[PLAN] 作为主智能体，我将拆解任务并分配给工作智能体，并制定验收标准 ${DEMO_TAG}`);
  } else if (prompt.includes('汇总')) {
    output(`[REPORT] 汇总报告：全部工作已完成 ${DEMO_TAG}`);
  } else if (prompt.includes('验收')) {
    output(`[ACCEPT] 验收通过：工作成果合格 ${DEMO_TAG}`);
  } else {
    output(`[PLAN] 收到任务，开始规划 ${DEMO_TAG}`);
  }
} else if (behavior === 'butler') {
  // 管家演示：规划时输出可解析的 JSON 调度方案；验收第1轮拒绝、第2轮通过；汇总时输出最终报告
  if (prompt.includes('圆桌讨论总结')) {
    output(`[圆桌总结] 共识：方案整体可行；分歧：实现优先级尚未定；建议行动：先做核心功能 ${DEMO_TAG}`);
  } else if (prompt.includes('主持人') && prompt.includes('CONVERGED')) {
    const rm = prompt.match(/第 (\d+) 轮发言结束/);
    const round = rm ? Number(rm[1]) : 1;
    if (round < 2) {
      output(`判定：存在信息缺口，需要继续 ${DEMO_TAG}\n\`\`\`json\n${JSON.stringify({ verdict: 'CONTINUE', question: '请重点讨论实现成本与风险' }, null, 2)}\n\`\`\``);
    } else {
      output(`判定：观点已充分交锋 ${DEMO_TAG}\n\`\`\`json\n{"verdict":"CONVERGED"}\n\`\`\``);
    }
  } else if (prompt.includes('最终正式回答') || prompt.includes('【各智能体产出】')) {
    // 汇总演示：照抄上游注入的成果文件完整路径（模拟管家按清单交付）
    const fm = prompt.match(/【成果文件完整路径[^\n]*】\n([\s\S]*?)(?=\n\s*\n|$)/);
    if (fm) {
      output(`[汇总] 已综合各子智能体的产出，任务完成。\n\n成果文件：\n${fm[1].trim()}\n\n以上为最终交付 ${DEMO_TAG}`);
    } else {
      output(`[汇总] 已综合各子智能体的产出，任务完成（本次无成果文件） ${DEMO_TAG}`);
    }
  } else if (prompt.includes('轮验收')) {
    const names = [...prompt.matchAll(/^【([^\s】]+) 的任务】/gm)].map(m => m[1]).filter(Boolean);
    if (prompt.includes('第 1 轮验收') && names.length > 0) {
      const issues = [{ agent: names[0], requirement: '补充关键细节与依据', suggestion: '请在结论中补充数据来源与具体步骤' }];
      output(`验收意见：部分成果还缺少细节，需要返工完善 ${DEMO_TAG}\n\`\`\`json\n${JSON.stringify({ verdict: 'REJECT', issues }, null, 2)}\n\`\`\``);
    } else {
      output(`验收意见：成果已满足用户需求，验收通过 ${DEMO_TAG}\n\`\`\`json\n{"verdict":"ACCEPT"}\n\`\`\``);
    }
  } else {
    const names = [...prompt.matchAll(/^- ([^（:：]+)[（:：]/gm)].map(m => m[1].trim()).filter(Boolean);
    if (names.length === 0) {
      output(`我是管家，这个需求我直接回答即可 ${DEMO_TAG}`);
    } else if (names.length === 1) {
      const steps = [[{ agent: names[0], instruction: '完成该任务的主要部分' }]];
      output(`我来安排「${names[0]}」完成这个任务 ${DEMO_TAG}\n\`\`\`json\n${JSON.stringify({ steps }, null, 2)}\n\`\`\``);
    } else {
      const steps = [
        [{ agent: names[0], instruction: '完成第一部分：调研与资料准备' }, { agent: names[1], instruction: '并行完成第二部分：独立子任务' }],
        [{ agent: names[0], instruction: '汇总前序成果，完成收尾' }]
      ];
      output(`我拆成两个阶段：先让「${names[0]}」「${names[1]}」并行工作，再由「${names[0]}」收尾 ${DEMO_TAG}\n\`\`\`json\n${JSON.stringify({ steps }, null, 2)}\n\`\`\``);
    }
  }
} else if (behavior === 'lead-always-reject') {
  if (prompt.includes('汇总')) {
    output(`[REPORT] 汇总报告：多轮验收后交付 ${DEMO_TAG}`);
  } else if (prompt.includes('验收')) {
    output(`[REJECT] 验收不通过：请改进后重做 ${DEMO_TAG}`);
  } else {
    output(`[PLAN] 收到任务 ${DEMO_TAG}`);
  }
} else {
  output(`完成：默认输出（${behavior}）${DEMO_TAG}`);
}
