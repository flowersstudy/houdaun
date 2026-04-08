const jwt = require('jsonwebtoken')

function authMiddleware(role) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ message: '未登录' })

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      if (role && decoded.role !== role) {
        return res.status(403).json({ message: '无权限' })
      }
      req.user = decoded
      next()
    } catch {
      res.status(401).json({ message: 'Token 无效或已过期' })
    }
  }
}

module.exports = authMiddleware
