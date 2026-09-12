// 插话（Steering）队列：AI 执行期间用户消息入队，本轮结束后由主循环 drain 续轮
// 纯函数集中于此，便于单测；server.js 持有队列实例
class SteerQueue {
  constructor({ max = 10 } = {}) {
    this.items = [];
    this.max = max; // 队列上限：防止无限插话导致 token 消耗失控
  }

  // 入队；超出上限返回 false（调用方提示用户）
  push(text) {
    if (this.items.length >= this.max) return false;
    this.items.push(text);
    return true;
  }

  // 取出全部（按序拼接由调用方决定）；无插话返回 ''
  drain(joiner = '\n\n') {
    if (this.items.length === 0) return '';
    const text = this.items.join(joiner);
    this.items.length = 0;
    return text;
  }

  clear() { this.items.length = 0; }

  get size() { return this.items.length; }
}

module.exports = { SteerQueue };
