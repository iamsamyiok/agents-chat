// 飞书桥接纯函数单测：消息解析 / 分段 / 事件去重
const test = require('node:test');
const assert = require('node:assert');
const bridge = require('../app/lib/bridge-feishu');

test('extractText：解析 content 并把 @ 占位符还原为名字', () => {
  const msg = {
    content: JSON.stringify({ text: '@_user_1 帮我调研一下市场' }),
    mentions: [{ key: '@_user_1', name: '张三' }]
  };
  assert.strictEqual(bridge.extractText(msg), '@张三 帮我调研一下市场');
});

test('extractText：无 mentions 时原样返回；坏 JSON 返回空串', () => {
  assert.strictEqual(bridge.extractText({ content: JSON.stringify({ text: '  hello  ' }) }), 'hello');
  assert.strictEqual(bridge.extractText({ content: 'not-json' }), '');
  assert.strictEqual(bridge.extractText({}), '');
});

test('splitSegments：短文本不分段；长文本按段落边界切分且不超过上限', () => {
  assert.deepStrictEqual(bridge.splitSegments('短消息'), ['短消息']);
  assert.deepStrictEqual(bridge.splitSegments(''), []);
  const long = Array.from({ length: 200 }, (_, i) => `段落 ${i}：${'内容'.repeat(30)}`).join('\n\n');
  const segs = bridge.splitSegments(long);
  assert.ok(segs.length > 1, '长文本应分段');
  for (const s of segs) assert.ok(s.length <= 3800, `每段不超过 3800：${s.length}`);
  assert.strictEqual(segs.join('\n\n').length, long.length, '分段拼接后总长守恒');
});

test('rememberEvent：同 id 只放行一次；容量上限自动清理', () => {
  // 注意：模块级 Set 是共享状态，本用例放入少量数据验证语义即可
  assert.strictEqual(bridge.rememberEvent('evt-a'), true);
  assert.strictEqual(bridge.rememberEvent('evt-a'), false); // 重复被拒
  assert.strictEqual(bridge.rememberEvent('evt-b'), true);
  assert.strictEqual(bridge.rememberEvent(''), false); // 空 id 不放行也不记录
});

test('start/stop：配置不全拒绝启动；空白名单允许启动，stop 后回收', () => {
  assert.strictEqual(bridge.start(null, {}), false);
  assert.strictEqual(bridge.start({ enabled: true, appId: '', appSecret: '' }, {}), false);
  assert.strictEqual(bridge.start({ enabled: false, appId: 'a', appSecret: 'b', allowedChats: ['oc_x'] }, {}), false);
  assert.strictEqual(bridge.isRunning(), false);
  // 空白名单允许启动（首条消息引导回填 chatId）；假凭证下 WS 异步连接失败不影响 state 就绪
  assert.strictEqual(bridge.start({ enabled: true, appId: 'cli_fake', appSecret: 'fake', allowedChats: [] }, {}), true);
  assert.strictEqual(bridge.isRunning(), true);
  bridge.stop();
  assert.strictEqual(bridge.isRunning(), false);
});

// ---- openclaw 模式补充用例 ----
const crypto = require('node:crypto');

test('dedupeKeyOf：文本消息内容级去重（同文同参同键，异文异键）；非文本退回 message_id', () => {
  const mk = (createTime, content) => ({ sender: { sender_id: { open_id: 'ou_1' } }, message: { message_type: 'text', chat_id: 'oc_9', create_time: createTime, content: JSON.stringify({ text: content }) } });
  const k1 = bridge.dedupeKeyOf(mk('1760000000', '你好'));
  const k2 = bridge.dedupeKeyOf(mk('1760000000', '你好')); // 重连重投（message_id 不同但内容相同）
  const k3 = bridge.dedupeKeyOf(mk('1760000001', '你好')); // 真实重发（create_time 变）
  assert.strictEqual(k1, k2, '重投同文应同键');
  assert.notStrictEqual(k1, k3, '真实重发应异键');
  const km = bridge.dedupeKeyOf({ message: { message_id: 'om_1', message_type: 'image', chat_id: 'oc_9', content: '{}' } });
  assert.ok(km.startsWith('mid-om_1'), '媒体消息按 message_id');
});

test('wantsCard：代码块/表格走卡片，纯文本走 post', () => {
  assert.strictEqual(bridge.wantsCard('普通文字'), false);
  assert.strictEqual(bridge.wantsCard('看代码：\n```js\nconsole.log(1)\n```'), true);
  assert.strictEqual(bridge.wantsCard('| A | B |\n| - | - |\n| 1 | 2 |'), true);
});

test('buildCardContent / buildPostContent：产出合法 JSON 信封', () => {
  const card = JSON.parse(bridge.buildCardContent('# 标题', '备注'));
  assert.strictEqual(card.schema, '2.0');
  assert.strictEqual(card.body.elements[0].tag, 'markdown');
  assert.strictEqual(card.body.elements[2].content, "<font color='grey'>备注</font>");
  const post = JSON.parse(bridge.buildPostContent('正文'));
  assert.strictEqual(post.zh_cn.content[0][0].tag, 'md');
  assert.strictEqual(post.zh_cn.content[0][0].text, '正文');
});

test('postToText：富文本元素递归渲染', () => {
  const t = bridge.postToText({ title: '日志', content: [[
    { tag: 'text', text: '开始 ' },
    { tag: 'at', user_name: '张三' },
    { tag: 'a', text: ' 链接' }
  ], [{ tag: 'img' }]] });
  assert.ok(t.startsWith('日志'));
  assert.ok(t.includes('开始 @张三 链接'));
  assert.ok(t.includes('[图片]'));
});

test('splitSegments：不完整代码围栏回退切分，代码块不被腰斩', () => {
  const code = '```js\n' + 'x'.repeat(3600) + '\n```';
  const text = '前言段落。' + code + '\n\n结尾说明文字若干。';
  const segs = bridge.splitSegments(text, 2000);
  assert.ok(segs.length >= 2);
  let fences = 0;
  for (const s of segs) fences += (s.match(/```/g) || []).length;
  assert.strictEqual(fences % 2, 0, '各段围栏总数应为偶数（代码块完整）');
  const joined = segs.join('');
  assert.ok(joined.includes('结尾说明'), '尾部内容不丢');
});
