const router = require('express').Router()
const jwt = require('jsonwebtoken')
const pool = require('../config/db')

router.use((req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ message: '未登录' })

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ message: 'Token 无效' })
  }
})

function formatListTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()

  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function mapStudentStatus(status) {
  return status === 'abnormal' ? 'warning' : status
}

function mapTeamRole(role) {
  switch (role) {
    case 'coach':
      return '带教老师'
    case 'diagnosis':
      return '诊断老师'
    case 'manager':
      return '学管'
    case 'principal':
      return '校长'
    default:
      return '老师'
  }
}

async function ensureRoom(teacherId, studentId) {
  const [rows] = await pool.query(
    'SELECT id, teacher_id, student_id FROM chat_rooms WHERE teacher_id = ? AND student_id = ? LIMIT 1',
    [teacherId, studentId]
  )

  if (rows[0]) return rows[0]

  try {
    const [result] = await pool.query(
      'INSERT INTO chat_rooms (teacher_id, student_id) VALUES (?, ?)',
      [teacherId, studentId]
    )
    return { id: result.insertId, teacher_id: teacherId, student_id: studentId }
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error
    const [retryRows] = await pool.query(
      'SELECT id, teacher_id, student_id FROM chat_rooms WHERE teacher_id = ? AND student_id = ? LIMIT 1',
      [teacherId, studentId]
    )
    return retryRows[0]
  }
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

async function getLastMessage(roomId) {
  const [rows] = await pool.query(
    `SELECT id, sender_type, sender_name, content, type, created_at
     FROM chat_messages
     WHERE room_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [roomId]
  )

  return rows[0] || null
}

async function listTeacherRooms(teacherId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT s.id AS student_id, s.name AS student_name, s.status,
            COALESCE(ts.subject, '') AS subject,
            COALESCE(ts.grade, '') AS grade
     FROM students s
     LEFT JOIN teacher_students ts ON ts.student_id = s.id AND ts.teacher_id = ?
     WHERE s.id IN (
       SELECT student_id FROM teacher_students WHERE teacher_id = ?
       UNION
       SELECT student_id FROM chat_rooms WHERE teacher_id = ?
     )
     ORDER BY s.id`,
    [teacherId, teacherId, teacherId]
  )

  const rooms = []
  for (const row of rows) {
    const room = await ensureRoom(teacherId, row.student_id)
    const lastMessage = await getLastMessage(room.id)
    rooms.push({
      id: String(room.id),
      name: row.student_name,
      avatar: String(row.student_name || '?').slice(0, 1),
      preview: lastMessage?.content || '',
      time: formatListTime(lastMessage?.created_at),
      unreadCount: 0,
      contactType: 'student',
      studentId: String(row.student_id),
      studentStatus: mapStudentStatus(row.status),
      subject: row.subject,
      grade: row.grade,
      lastSenderType: lastMessage?.sender_type || null,
      lastMessageAt: lastMessage?.created_at || null,
    })
  }

  return rooms
}

async function listStudentRooms(studentId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT t.id AS teacher_id, t.name AS teacher_name, t.title,
            COALESCE(ts.subject, '') AS subject,
            COALESCE(ts.grade, '') AS grade
     FROM teachers t
     LEFT JOIN teacher_students ts ON ts.teacher_id = t.id AND ts.student_id = ?
     WHERE t.id IN (
       SELECT teacher_id FROM student_team_members WHERE student_id = ?
       UNION
       SELECT teacher_id FROM teacher_students WHERE student_id = ?
       UNION
       SELECT teacher_id FROM chat_rooms WHERE student_id = ?
     )
     ORDER BY t.id`,
    [studentId, studentId, studentId, studentId]
  )

  const rooms = []
  for (const row of rows) {
    const room = await ensureRoom(row.teacher_id, studentId)
    const lastMessage = await getLastMessage(room.id)
    rooms.push({
      id: String(room.id),
      name: row.teacher_name,
      avatar: String(row.teacher_name || '?').slice(0, 1),
      preview: lastMessage?.content || '',
      time: formatListTime(lastMessage?.created_at),
      unreadCount: 0,
      contactType: 'teacher',
      subject: row.subject,
      grade: row.grade,
      title: row.title || '',
      lastSenderType: lastMessage?.sender_type || null,
      lastMessageAt: lastMessage?.created_at || null,
    })
  }

  return rooms
}

async function buildRoomMembers(room, user) {
  const [[student]] = await pool.query(
    'SELECT id, name FROM students WHERE id = ? LIMIT 1',
    [room.student_id]
  )

  if (user.role === 'student') {
    const [teamRows] = await pool.query(
      `SELECT t.id, t.name, stm.role
       FROM student_team_members stm
       JOIN teachers t ON t.id = stm.teacher_id
       WHERE stm.student_id = ?
       ORDER BY FIELD(stm.role, 'coach', 'diagnosis', 'manager', 'principal'), t.id`,
      [room.student_id]
    )

    const members = [
      {
        id: `student-${student.id}`,
        name: student.name,
        role: '学生',
        avatar: String(student.name || '?').slice(0, 1),
      },
      ...teamRows.map((item) => ({
        id: `teacher-${item.id}`,
        name: item.name,
        role: mapTeamRole(item.role),
        avatar: String(item.name || '?').slice(0, 1),
      })),
    ]

    return members
  }

  const [[teacher]] = await pool.query(
    'SELECT id, name FROM teachers WHERE id = ? LIMIT 1',
    [room.teacher_id]
  )

  return [
    {
      id: `teacher-${teacher.id}`,
      name: teacher.name,
      role: '带教老师',
      avatar: String(teacher.name || '?').slice(0, 1),
    },
    {
      id: `student-${student.id}`,
      name: student.name,
      role: '学生',
      avatar: String(student.name || '?').slice(0, 1),
    },
  ]
}

router.get('/rooms', async (req, res) => {
  try {
    const rooms = req.user.role === 'teacher'
      ? await listTeacherRooms(req.user.id)
      : await listStudentRooms(req.user.id)

    res.json(rooms)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

router.get('/rooms/:roomId/members', async (req, res) => {
  try {
    const room = await getRoomWithAccess(req.params.roomId, req.user)
    if (!room) return res.status(404).json({ message: '聊天房间不存在' })

    const members = await buildRoomMembers(room, req.user)
    res.json(members)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

async function handleGetMessages(req, res) {
  const { roomId } = req.params
  const { before, limit = 30 } = req.query

  try {
    const room = await getRoomWithAccess(roomId, req.user)
    if (!room) return res.status(404).json({ message: '聊天房间不存在' })

    let sql = `SELECT id, room_id, sender_type, sender_name, content, type, reply_to_id, created_at
               FROM chat_messages
               WHERE room_id = ?`
    const params = [roomId]

    if (before) {
      sql += ' AND id < ?'
      params.push(before)
    }

    sql += ' ORDER BY id DESC LIMIT ?'
    params.push(Number(limit))

    const [rows] = await pool.query(sql, params)
    res.json(rows.reverse().map((item) => ({
      id: String(item.id),
      roomId: String(item.room_id),
      senderType: item.sender_type,
      senderName: item.sender_name,
      content: item.content,
      type: item.type,
      replyToId: item.reply_to_id ? String(item.reply_to_id) : null,
      createdAt: item.created_at,
    })))
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

async function handlePostMessage(req, res) {
  const { roomId } = req.params
  const { content, type = 'text', reply_to_id } = req.body

  if (!String(content || '').trim()) {
    return res.status(400).json({ message: '消息内容不能为空' })
  }

  try {
    const room = await getRoomWithAccess(roomId, req.user)
    if (!room) return res.status(404).json({ message: '聊天房间不存在' })

    const [result] = await pool.query(
      `INSERT INTO chat_messages (room_id, sender_type, sender_id, sender_name, content, type, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [roomId, req.user.role, req.user.id, req.user.name, String(content).trim(), type, reply_to_id || null]
    )

    const [[message]] = await pool.query(
      `SELECT id, room_id, sender_type, sender_name, content, type, reply_to_id, created_at
       FROM chat_messages
       WHERE id = ? LIMIT 1`,
      [result.insertId]
    )

    res.json({
      id: String(message.id),
      roomId: String(message.room_id),
      senderType: message.sender_type,
      senderName: message.sender_name,
      content: message.content,
      type: message.type,
      replyToId: message.reply_to_id ? String(message.reply_to_id) : null,
      createdAt: message.created_at,
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

router.get('/rooms/:roomId/messages', handleGetMessages)
router.post('/rooms/:roomId/messages', handlePostMessage)
router.get('/:roomId/messages', handleGetMessages)
router.post('/:roomId/messages', handlePostMessage)

module.exports = router
