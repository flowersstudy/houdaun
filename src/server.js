const http = require('http')
const { WebSocketServer } = require('ws')
const jwt = require('jsonwebtoken')
const app = require('./app')
require('dotenv').config()

const server = http.createServer(app)

// WebSocket 实时聊天
const wss = new WebSocketServer({ server })
const rooms = new Map()

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?', ''))
  const token = params.get('token')
  const roomId = params.get('roomId')

  try {
    ws.user = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    ws.close(1008, 'Token 无效')
    return
  }

  if (!rooms.has(roomId)) rooms.set(roomId, new Set())
  rooms.get(roomId).add(ws)

  ws.on('message', (data) => {
    rooms.get(roomId)?.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(data.toString())
      }
    })
  })

  ws.on('close', () => {
    rooms.get(roomId)?.delete(ws)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`后端服务已启动：http://localhost:${PORT}`)
})
