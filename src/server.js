const http = require('http')
const { WebSocketServer } = require('ws')
const jwt = require('jsonwebtoken')
const app = require('./app')
const pool = require('./config/db')
const { startClassReminderScheduler } = require('./lib/classReminder')
require('dotenv').config()

const server = http.createServer(app)

const wss = new WebSocketServer({ server })
const rooms = new Map()

function isBrokenText(value) {
  if (value === null || value === undefined) return true
  const raw = String(value).trim()
  if (!raw) return true
  const cleaned = raw.replace(/[?？\s,，.。!！:：;；、'"“”‘’\-_/\\|()[\]{}<>~`@#$%^&*+=]+/g, '')
  return cleaned.length === 0
}

function sanitizeDisplayText(value, fallback) {
  return isBrokenText(value) ? fallback : String(value).trim()
}

function sanitizeMessageContent(content) {
  return sanitizeDisplayText(content, '欢迎来到聊天房间，我们可以在这里实时沟通。')
}

function sanitizeUserName(user) {
  if (user.role === 'teacher') {
    return sanitizeDisplayText(user.name, '老师')
  }
  return sanitizeDisplayText(user.name, '同学')
}

async function getRoomWithAccess(roomId, user) {
  const [rows] = await pool.query(
    'SELECT id, teacher_id, student_id FROM chat_rooms WHERE id = ? LIMIT 1',
    [roomId]
  )
  const room = rows[0]

  if (!room) return null
  if (user.role === 'teacher' && Number(room.teacher_id) === Number(user.id)) return room
  if (user.role === 'student' && Number(room.student_id) === Number(user.id)) return room
  return null
}

async function insertChatMessage({ roomId, user, content, messageType = 'text', replyToId = null }) {
  const [result] = await pool.query(
    `INSERT INTO chat_messages (room_id, sender_type, sender_id, sender_name, content, type, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [roomId, user.role, user.id, sanitizeUserName(user), String(content).trim(), messageType, replyToId]
  )

  const [[message]] = await pool.query(
    `SELECT id, room_id, sender_type, sender_name, content, type, reply_to_id, created_at
     FROM chat_messages
     WHERE id = ? LIMIT 1`,
    [result.insertId]
  )

  return message
}

function formatOutgoingMessage(message) {
  return {
    id: String(message.id),
    roomId: String(message.room_id),
    senderType: message.sender_type,
    senderName: message.sender_type === 'teacher'
      ? sanitizeDisplayText(message.sender_name, '老师')
      : sanitizeDisplayText(message.sender_name, '同学'),
    content: sanitizeMessageContent(message.content),
    messageType: message.type,
    replyToId: message.reply_to_id ? String(message.reply_to_id) : null,
    createdAt: message.created_at,
  }
}

function sendJson(ws, payload) {
  if (ws.readyState !== 1) return
  ws.send(JSON.stringify(payload))
}

function addRoomClient(roomId, ws) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set())
  }
  rooms.get(roomId).add(ws)
}

function removeRoomClient(roomId, ws) {
  const roomClients = rooms.get(roomId)
  if (!roomClients) return
  roomClients.delete(ws)
  if (roomClients.size === 0) {
    rooms.delete(roomId)
  }
}

wss.on('connection', async (ws, req) => {
  const requestUrl = new URL(req.url, 'http://localhost')
  const token = requestUrl.searchParams.get('token')
  const roomId = requestUrl.searchParams.get('roomId')

  if (!token || !roomId) {
    ws.close(1008, '缺少 token 或 roomId')
    return
  }

  try {
    ws.user = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    ws.close(1008, 'Token 无效')
    return
  }

  try {
    const room = await getRoomWithAccess(roomId, ws.user)
    if (!room) {
      ws.close(1008, '聊天房间不存在或无权限')
      return
    }

    ws.roomId = String(room.id)
    addRoomClient(ws.roomId, ws)
    sendJson(ws, {
      type: 'connected',
      roomId: ws.roomId,
    })
  } catch (error) {
    ws.close(1011, '聊天服务初始化失败')
    return
  }

  ws.on('message', async (data) => {
    let payload

    try {
      payload = JSON.parse(data.toString())
    } catch {
      sendJson(ws, { type: 'error', message: '消息格式错误' })
      return
    }

    if (payload.type === 'ping') {
      sendJson(ws, { type: 'pong', timestamp: Date.now() })
      return
    }

    if (payload.type !== 'chat_message') {
      sendJson(ws, { type: 'error', message: '不支持的消息类型' })
      return
    }

    const content = String(payload.content || '').trim()
    if (!content) {
      sendJson(ws, {
        type: 'error',
        clientId: payload.clientId || '',
        message: '消息内容不能为空',
      })
      return
    }

    if (String(payload.roomId || ws.roomId) !== String(ws.roomId)) {
      sendJson(ws, {
        type: 'error',
        clientId: payload.clientId || '',
        message: '房间不匹配',
      })
      return
    }

    try {
      const message = await insertChatMessage({
        roomId: ws.roomId,
        user: ws.user,
        content,
        messageType: payload.messageType || 'text',
        replyToId: payload.replyToId || null,
      })
      const messagePayload = formatOutgoingMessage(message)

      sendJson(ws, {
        type: 'ack',
        clientId: payload.clientId || '',
        message: messagePayload,
      })

      rooms.get(ws.roomId)?.forEach((client) => {
        if (client === ws || client.readyState !== 1) {
          return
        }

        sendJson(client, {
          type: 'chat_message',
          message: messagePayload,
        })
      })
    } catch (error) {
      sendJson(ws, {
        type: 'error',
        clientId: payload.clientId || '',
        message: '消息发送失败',
      })
    }
  })

  ws.on('close', () => {
    removeRoomClient(ws.roomId, ws)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`后端服务已启动：http://localhost:${PORT}`)
  startClassReminderScheduler()
})
