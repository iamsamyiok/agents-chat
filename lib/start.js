// lib/start.js - 向后兼容的启动模块
// 这个模块被 bin/agents-chat.js 调用，提供与原始项目兼容的启动方式

const { startServer, stopServer, isRunning } = require('../bin/agents-chat');

module.exports = {
  start: startServer,
  stop: stopServer,
  isRunning: isRunning
};
