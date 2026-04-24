const db = require('../config/db')

// 拦截所有 4xx/5xx 响应，写入 api_error_logs 表
// 不改任何业务逻辑，只做旁路记录
function errorLoggerMiddleware(req, res, next) {
  const originalJson = res.json.bind(res)

  res.json = function (body) {
    const status = res.statusCode
    if (status >= 400) {
      const msg = (body && (body.error || body.message)) || JSON.stringify(body) || ''
      const userId = req.user ? req.user.id : null
      const userRole = req.user ? req.user.role : null
      // 异步写入，不阻塞响应
      db.query(
        'INSERT INTO api_error_logs (method, path, status_code, error_msg, user_id, user_role) VALUES (?, ?, ?, ?, ?, ?)',
        [req.method, req.path, status, msg.slice(0, 1000), userId, userRole]
      ).catch(() => {}) // 日志写入失败不影响主流程
    }
    return originalJson(body)
  }

  next()
}

module.exports = errorLoggerMiddleware
