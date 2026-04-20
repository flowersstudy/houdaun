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

function mapDisplayRoleToTeamRole(role) {
  switch (role) {
    case '\u5e26\u6559\u8001\u5e08':
    case 'coach':
      return 'coach'
    case '\u8bca\u65ad\u8001\u5e08':
    case 'diagnosis':
      return 'diagnosis'
    case '\u5b66\u7ba1':
    case 'manager':
      return 'manager'
    case '\u6821\u957f':
    case 'principal':
      return 'principal'
    default:
      return null
  }
}

function inferTeamRoleFromTitle(title) {
  const value = String(title || '')
  if (value.includes('\u6821\u957f') || value.toLowerCase().includes('principal')) return 'principal'
  if (value.includes('\u5b66\u7ba1') || value.toLowerCase().includes('manager')) return 'manager'
  if (value.includes('\u8bca\u65ad') || value.toLowerCase().includes('diagnosis')) return 'diagnosis'
  return 'coach'
}

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

function fallbackTeacherName(teacherId) {
  const labels = {
    1: '李老师',
    5: '王老师',
    6: '陈老师',
    7: '林老师',
    8: '刘校长',
  }
  return labels[teacherId] || '老师'
}

function fallbackTeacherTitle(title, teacherId) {
  if (!isBrokenText(title)) {
    return String(title).trim()
  }

  return teacherId === 8 ? '校长' : '带教老师'
}

function fallbackStudentName(studentId) {
  return studentId === 1 ? '张三' : `同学${studentId}`
}

function sanitizeMessageContent(content) {
  return sanitizeDisplayText(content, '欢迎来到聊天房间，我们可以在这里实时沟通。')
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

async function ensureTeacherStudentRelation(teacherId, studentId, subject = '', grade = '') {
  const [rows] = await pool.query(
    'SELECT id FROM teacher_students WHERE teacher_id = ? AND student_id = ? LIMIT 1',
    [teacherId, studentId]
  )

  if (rows[0]) {
    return rows[0]
  }

  const [result] = await pool.query(
    'INSERT INTO teacher_students (teacher_id, student_id, subject, grade) VALUES (?, ?, ?, ?)',
    [teacherId, studentId, subject, grade]
  )

  return { id: result.insertId }
}

async function ensureTeamMember(studentId, teacherId, role) {
  const [rows] = await pool.query(
    'SELECT id FROM student_team_members WHERE student_id = ? AND teacher_id = ? AND role = ? LIMIT 1',
    [studentId, teacherId, role]
  )

  if (rows[0]) {
    return rows[0]
  }

  const [result] = await pool.query(
    'INSERT INTO student_team_members (student_id, teacher_id, role, status) VALUES (?, ?, ?, ?)',
    [studentId, teacherId, role, 'assigned']
  )

  return { id: result.insertId }
}

async function seedRoomMessagesIfNeeded(roomId, studentName, teacherName) {
  const [[countRow]] = await pool.query(
    'SELECT COUNT(*) AS count FROM chat_messages WHERE room_id = ?',
    [roomId]
  )

  if (Number(countRow && countRow.count) > 0) {
    return
  }

  const samples = [
    ['teacher', teacherName, '你好，我是你的带教老师。接下来我们就通过这里实时沟通。'],
    ['student', studentName, '老师好，我这边先来试一下聊天功能。'],
    ['teacher', teacherName, '已经收到你的消息了，后续作业提醒、答疑和课节安排都可以在这里同步。'],
  ]

  for (const item of samples) {
    await pool.query(
      'INSERT INTO chat_messages (room_id, sender_type, sender_id, sender_name, content, type) VALUES (?, ?, ?, ?, ?, ?)',
      [roomId, item[0], 0, item[1], item[2], 'text']
    )
  }
}

async function bootstrapStudentChatData(studentId) {
  if (process.env.NODE_ENV === 'production') {
    return
  }

  const [[student]] = await pool.query(
    'SELECT id, name FROM students WHERE id = ? LIMIT 1',
    [studentId]
  )

  if (!student) {
    return
  }

  const [teacherRows] = await pool.query(
    `SELECT t.id, t.name, COALESCE(t.title, '') AS title,
            COALESCE(ts.subject, '') AS subject,
            COALESCE(ts.grade, '') AS grade
     FROM teachers t
     LEFT JOIN teacher_students ts ON ts.teacher_id = t.id AND ts.student_id = ?
     ORDER BY t.id
     LIMIT 4`,
    [studentId]
  )

  if (!teacherRows.length) {
    return
  }

  const roles = ['coach', 'diagnosis', 'manager', 'principal']
  const primaryTeacher = teacherRows[0]

  await ensureTeacherStudentRelation(primaryTeacher.id, studentId, primaryTeacher.subject, primaryTeacher.grade)

  for (let index = 0; index < teacherRows.length && index < roles.length; index += 1) {
    await ensureTeamMember(studentId, teacherRows[index].id, roles[index])
  }

  const room = await ensureRoom(primaryTeacher.id, studentId)
  await seedRoomMessagesIfNeeded(room.id, student.name, primaryTeacher.name)
}

async function getRoomWithAccess(roomId, user) {
  const [rows] = await pool.query(
    'SELECT id, teacher_id, student_id FROM chat_rooms WHERE id = ? LIMIT 1',
    [roomId]
  )
  const room = rows[0]

  if (!room) return null

  if (user.role === 'student' && Number(room.student_id) === Number(user.id)) return room

  if (user.role === 'teacher') {
    const [relationRows] = await pool.query(
      `SELECT id FROM teacher_students
       WHERE teacher_id = ? AND student_id = ?
       LIMIT 1`,
      [user.id, room.student_id]
    )
    if (relationRows[0]) return room
  }

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
     FROM teacher_students ts
     JOIN students s ON s.id = ts.student_id
     WHERE ts.teacher_id = ?
     ORDER BY s.id`,
    [teacherId]
  )

  const rooms = []
  for (const row of rows) {
    const room = await ensureRoom(teacherId, row.student_id)
    const lastMessage = await getLastMessage(room.id)
    rooms.push({
      id: String(room.id),
      name: sanitizeDisplayText(row.student_name, fallbackStudentName(row.student_id)),
      avatar: sanitizeDisplayText(row.student_name, fallbackStudentName(row.student_id)).slice(0, 1),
      preview: lastMessage ? sanitizeMessageContent(lastMessage.content) : '',
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
  let [rows] = await pool.query(
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

  if (!rows.length && process.env.NODE_ENV !== 'production') {
    await bootstrapStudentChatData(studentId)
    ;[rows] = await pool.query(
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
  }

  const rooms = []
  for (const row of rows) {
    const room = await ensureRoom(row.teacher_id, studentId)
    const lastMessage = await getLastMessage(room.id)
    const teacherName = sanitizeDisplayText(row.teacher_name, fallbackTeacherName(row.teacher_id))
    rooms.push({
      id: String(room.id),
      name: teacherName,
      avatar: teacherName.slice(0, 1),
      preview: lastMessage ? sanitizeMessageContent(lastMessage.content) : '',
      time: formatListTime(lastMessage?.created_at),
      unreadCount: 0,
      contactType: 'teacher',
      subject: row.subject,
      grade: row.grade,
      title: fallbackTeacherTitle(row.title, row.teacher_id),
      lastSenderType: lastMessage?.sender_type || null,
      lastMessageAt: lastMessage?.created_at || null,
    })
  }

  return rooms
}

async function buildRoomMembers(room) {
  const [[student]] = await pool.query(
    'SELECT id, name FROM students WHERE id = ? LIMIT 1',
    [room.student_id]
  )

  const [teamRows] = await pool.query(
    `SELECT t.id, t.name, stm.role
     FROM student_team_members stm
     JOIN teachers t ON t.id = stm.teacher_id
     WHERE stm.student_id = ? AND stm.status <> 'inactive'
     ORDER BY FIELD(stm.role, 'coach', 'diagnosis', 'manager', 'principal'), t.id`,
    [room.student_id]
  )

  if (!teamRows.some((item) => Number(item.id) === Number(room.teacher_id))) {
    const [[primaryTeacher]] = await pool.query(
      'SELECT id, name FROM teachers WHERE id = ? LIMIT 1',
      [room.teacher_id]
    )

    if (primaryTeacher) {
      teamRows.unshift({ id: primaryTeacher.id, name: primaryTeacher.name, role: 'coach' })
    }
  }

  return [
    {
      id: `student-${student?.id || room.student_id}`,
      name: sanitizeDisplayText(student?.name, fallbackStudentName(room.student_id)),
      role: '学生',
      avatar: sanitizeDisplayText(student?.name, fallbackStudentName(room.student_id)).slice(0, 1),
    },
    ...teamRows.map((item) => {
      const name = sanitizeDisplayText(item.name, fallbackTeacherName(item.id))
      return {
        id: `teacher-${item.id}`,
        teacherId: String(item.id),
        name,
        role: mapTeamRole(item.role),
        avatar: name.slice(0, 1),
      }
    }),
  ]
}

function toMemberPayload(teacher, role) {
  const name = sanitizeDisplayText(teacher.name, fallbackTeacherName(teacher.id))
  return {
    id: `teacher-${teacher.id}`,
    teacherId: String(teacher.id),
    name,
    role: mapTeamRole(role),
    avatar: name.slice(0, 1),
  }
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

    const members = await buildRoomMembers(room)
    res.json(members)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

router.get('/rooms/:roomId/member-candidates', async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ message: '只有老师可以管理群成员' })
  }

  try {
    const room = await getRoomWithAccess(req.params.roomId, req.user)
    if (!room) return res.status(404).json({ message: '聊天房间不存在' })

    const [existingRows] = await pool.query(
      `SELECT teacher_id, role FROM student_team_members
       WHERE student_id = ? AND status <> 'inactive'`,
      [room.student_id]
    )
    const existingTeacherIds = new Set(existingRows.map((item) => Number(item.teacher_id)))
    const usedRoles = new Set(existingRows.map((item) => item.role))
    existingTeacherIds.add(Number(room.teacher_id))
    usedRoles.add('coach')

    const [teachers] = await pool.query('SELECT id, name, title FROM teachers ORDER BY id')
    const candidates = teachers
      .map((teacher) => ({ ...teacher, role: inferTeamRoleFromTitle(teacher.title) }))
      .filter((teacher) => !existingTeacherIds.has(Number(teacher.id)))
      .filter((teacher) => !usedRoles.has(teacher.role))
      .map((teacher) => toMemberPayload(teacher, teacher.role))

    res.json(candidates)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

router.post('/rooms/:roomId/members', async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ message: '只有老师可以管理群成员' })
  }

  const teacherId = Number(req.body.teacherId)
  const role = mapDisplayRoleToTeamRole(req.body.role)

  if (!teacherId || !role) {
    return res.status(400).json({ message: '请选择要加入的老师和角色' })
  }

  try {
    const room = await getRoomWithAccess(req.params.roomId, req.user)
    if (!room) return res.status(404).json({ message: '聊天房间不存在' })

    const [[teacher]] = await pool.query(
      'SELECT id, name FROM teachers WHERE id = ? LIMIT 1',
      [teacherId]
    )
    if (!teacher) return res.status(404).json({ message: '老师不存在' })

    await ensureTeacherStudentRelation(teacherId, room.student_id)
    await ensureRoom(teacherId, room.student_id)
    await pool.query(
      `INSERT INTO student_team_members (student_id, teacher_id, role, status)
       VALUES (?, ?, ?, 'assigned')
       ON DUPLICATE KEY UPDATE teacher_id = VALUES(teacher_id), status = 'assigned', assigned_at = NOW()`,
      [room.student_id, teacherId, role]
    )

    res.status(201).json(toMemberPayload(teacher, role))
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

router.delete('/rooms/:roomId/members/:teacherId', async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ message: '只有老师可以管理群成员' })
  }

  const teacherId = Number(req.params.teacherId)
  if (!teacherId) return res.status(400).json({ message: '老师 ID 无效' })

  try {
    const room = await getRoomWithAccess(req.params.roomId, req.user)
    if (!room) return res.status(404).json({ message: '聊天房间不存在' })
    if (Number(room.teacher_id) === teacherId) {
      return res.status(400).json({ message: '不能移出主带教老师' })
    }

    await pool.query(
      'DELETE FROM student_team_members WHERE student_id = ? AND teacher_id = ?',
      [room.student_id, teacherId]
    )

    res.json({ message: '已移出群成员' })
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
      senderName: item.sender_type === 'teacher'
        ? sanitizeDisplayText(item.sender_name, '老师')
        : sanitizeDisplayText(item.sender_name, '同学'),
      content: sanitizeMessageContent(item.content),
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
