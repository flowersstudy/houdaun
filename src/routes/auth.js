const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const axios = require('axios')
const crypto = require('crypto')
const pool = require('../config/db')
const auth = require('../middleware/auth')

function issueToken(user) {
  return jwt.sign(user, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  })
}

function buildStudentAuthPayload(student) {
  const token = issueToken({
    id: student.id,
    role: 'student',
    name: student.name,
  })

  return {
    token,
    name: student.name,
    id: student.id,
    status: student.status,
    phone: student.phone || '',
    avatarUrl: student.avatar_url || '',
  }
}

async function getStudentAuthRecordById(studentId) {
  if (!studentId) {
    return null
  }

  const [rows] = await pool.query(
    `SELECT s.id, s.account, s.phone, s.password_hash, s.name, s.status, s.openid,
            sp.avatar_url
     FROM students s
     LEFT JOIN student_profiles sp ON sp.student_id = s.id
     WHERE s.id = ?
     LIMIT 1`,
    [studentId]
  )

  return rows[0] || null
}

function normalizeStudentAccount(value) {
  return String(value || '').trim()
}

function normalizeStudentName(value) {
  return String(value || '').trim()
}

function normalizeStudentPassword(value) {
  return String(value || '')
}

async function ensureStudentVisibleForTeachers(studentId) {
  const safeStudentId = Number(studentId)
  if (!safeStudentId) {
    return
  }

  await pool.query(
    `INSERT INTO teacher_students (teacher_id, student_id, subject, grade)
     SELECT t.id, ?, '申论', NULL
     FROM teachers t
     LEFT JOIN teacher_students ts
       ON ts.teacher_id = t.id
      AND ts.student_id = ?
     WHERE ts.id IS NULL`,
    [safeStudentId, safeStudentId]
  )

  await pool.query(
    `INSERT INTO practice_assignment_tasks (teacher_id, student_id, checkpoint, detail, status)
     SELECT t.id, ?, NULL, '待分配学习方案', 'pending'
     FROM teachers t
     LEFT JOIN practice_assignment_tasks pat
       ON pat.teacher_id = t.id
      AND pat.student_id = ?
     WHERE pat.id IS NULL`,
    [safeStudentId, safeStudentId]
  )
}

function canUseDevWxFallback() {
  return process.env.NODE_ENV !== 'production'
}

function isDevOpenId(openid = '') {
  return /^dev_(wx|openid)_/i.test(String(openid || '').trim())
}

function buildDevOpenId(code) {
  const digest = crypto.createHash('sha1').update(String(code || 'dev')).digest('hex')
  return `dev_wx_${digest.slice(0, 24)}`
}

async function resolveWxOpenId(code) {
  const allowDevFallback = canUseDevWxFallback()

  if (!process.env.WX_APPID || !process.env.WX_SECRET) {
    if (allowDevFallback) {
      return buildDevOpenId(code)
    }

    throw new Error('未配置微信登录参数，请检查 WX_APPID 和 WX_SECRET')
  }

  try {
    const { data } = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: process.env.WX_APPID,
        secret: process.env.WX_SECRET,
        js_code: code,
        grant_type: 'authorization_code',
      },
    })

    if (data.errcode) {
      if (allowDevFallback) {
        return buildDevOpenId(code)
      }

      const error = new Error(
        data.errcode === 40125
          ? '微信登录失败，请检查后端 WX_APPID/WX_SECRET 是否正确'
          : '微信登录失败'
      )
      error.errcode = data.errcode
      throw error
    }

    return data.openid
  } catch (error) {
    if (allowDevFallback) {
      return buildDevOpenId(code)
    }

    throw error
  }
}

router.post('/teacher/login', async (req, res) => {
  const { email, password } = req.body

  try {
    const [rows] = await pool.query('SELECT * FROM teachers WHERE email = ?', [email])
    const teacher = rows[0]

    if (!teacher || !await bcrypt.compare(password, teacher.password_hash)) {
      return res.status(401).json({ message: '账号或密码错误' })
    }

    const token = jwt.sign(
      { id: teacher.id, role: 'teacher', name: teacher.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({ token, name: teacher.name, id: teacher.id })
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

router.post('/teacher/register', async (req, res) => {
  const { name, email, password } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ message: '请填写完整信息' })
  }

  if (password.length < 6) {
    return res.status(400).json({ message: '密码至少 6 位' })
  }

  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [existing] = await connection.query('SELECT id FROM teachers WHERE email = ?', [email])
    if (existing.length > 0) {
      await connection.rollback()
      return res.status(409).json({ message: '该邮箱已注册' })
    }

    const hash = await bcrypt.hash(password, 10)
    const [result] = await connection.query(
      'INSERT INTO teachers (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, hash]
    )

    await connection.query(
      `INSERT INTO teacher_students (teacher_id, student_id, subject, grade)
       SELECT ?, s.id, ?, NULL
       FROM students s
       LEFT JOIN teacher_students ts ON ts.teacher_id = ? AND ts.student_id = s.id
       WHERE ts.id IS NULL`,
      [result.insertId, '申论', result.insertId]
    )

    await connection.commit()

    const token = jwt.sign(
      { id: result.insertId, role: "teacher", name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({ token, name, id: result.insertId })
  } catch (error) {
    if (connection) {
      await connection.rollback()
    }
    res.status(500).json({ message: '服务器错误', error: error.message })
  } finally {
    if (connection) {
      connection.release()
    }
  }
})

router.post('/student/login', async (req, res) => {
  const account = normalizeStudentAccount(req.body.account)
  const password = normalizeStudentPassword(req.body.password)

  if (!account || !password) {
    return res.status(400).json({ message: '请填写账号和密码' })
  }

  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.account, s.phone, s.password_hash, s.name, s.status, sp.avatar_url
       FROM students s
       LEFT JOIN student_profiles sp ON sp.student_id = s.id
       WHERE s.account = ? OR s.phone = ?
       LIMIT 1`,
      [account, account]
    )
    const student = rows[0]
    const passwordMatches = student && student.password_hash
      ? await bcrypt.compare(password, student.password_hash)
      : false

    if (!student || !passwordMatches) {
      return res.status(401).json({ message: '账号或密码错误' })
    }

    await ensureStudentVisibleForTeachers(student.id)

    res.json(buildStudentAuthPayload(student))
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

router.post('/student/register', async (req, res) => {
  const name = normalizeStudentName(req.body.name)
  const account = normalizeStudentAccount(req.body.account)
  const password = normalizeStudentPassword(req.body.password)

  if (!name || !account || !password) {
    return res.status(400).json({ message: '请填写姓名、账号和密码' })
  }

  if (account.length < 4) {
    return res.status(400).json({ message: '账号至少 4 位' })
  }

  if (password.length < 6) {
    return res.status(400).json({ message: '密码至少 6 位' })
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM students WHERE account = ? LIMIT 1',
      [account]
    )

    if (existing.length > 0) {
      return res.status(409).json({ message: '该账号已注册' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const [result] = await pool.query(
      `INSERT INTO students (account, password_hash, name, status)
       VALUES (?, ?, ?, 'new')`,
      [account, passwordHash, name]
    )

    await ensureStudentVisibleForTeachers(result.insertId)

    res.json(buildStudentAuthPayload(await getStudentAuthRecordById(result.insertId)))
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

router.post('/student/wx-login', async (req, res) => {
  const { code } = req.body

  if (!code) {
    return res.status(400).json({ message: '缺少微信登录 code' })
  }

  try {
    const openid = await resolveWxOpenId(code)
    let [rows] = await pool.query(
      `SELECT s.id, s.account, s.phone, s.password_hash, s.name, s.status, s.openid, sp.avatar_url
       FROM students s
       LEFT JOIN student_profiles sp ON sp.student_id = s.id
       WHERE s.openid = ?
       LIMIT 1`,
      [openid]
    )
    let student = rows[0]

    if (!student) {
      const [result] = await pool.query(
        'INSERT INTO students (openid, name, status) VALUES (?, ?, ?)',
        [openid, '新学员', 'new']
      )
      student = await getStudentAuthRecordById(result.insertId)
    }

    res.json(buildStudentAuthPayload(student))
  } catch (error) {
    if (error.errcode) {
      return res.status(400).json({ message: error.message, errcode: error.errcode })
    }

    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

router.post('/student/bind-phone', auth('student'), async (req, res) => {
  const phone = String(req.body.phone || '').trim()

  if (!phone) {
    return res.status(400).json({ message: '请先填写手机号' })
  }

  let conn

  try {
    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[currentStudent]] = await conn.query(
      'SELECT id, openid, phone, name, status FROM students WHERE id = ? LIMIT 1 FOR UPDATE',
      [req.user.id]
    )

    if (!currentStudent) {
      await conn.rollback()
      return res.status(404).json({ message: '当前学生不存在' })
    }

    if (!currentStudent.openid) {
      await conn.rollback()
      return res.status(400).json({ message: '当前账号缺少微信标识，请重新登录后再试' })
    }

    const [[targetStudent]] = await conn.query(
      'SELECT id, openid, phone, name, status FROM students WHERE phone = ? LIMIT 1 FOR UPDATE',
      [phone]
    )

    if (!targetStudent) {
      await conn.rollback()
      return res.status(404).json({ message: '未找到该手机号对应的学生档案' })
    }

    if (
      Number(targetStudent.id) !== Number(currentStudent.id)
      && currentStudent.status !== 'new'
    ) {
      await conn.rollback()
      return res.status(400).json({ message: '当前账号已是正式学员，无需再次绑定' })
    }

    const canRebindDevOpenId = (
      canUseDevWxFallback()
      && targetStudent.openid
      && targetStudent.openid !== currentStudent.openid
      && isDevOpenId(targetStudent.openid)
      && isDevOpenId(currentStudent.openid)
    )

    if (
      targetStudent.openid
      && targetStudent.openid !== currentStudent.openid
      && !canRebindDevOpenId
    ) {
      await conn.rollback()
      return res.status(409).json({ message: '该手机号已绑定其他微信账号' })
    }

    if (Number(targetStudent.id) !== Number(currentStudent.id)) {
      await conn.query('UPDATE students SET openid = NULL WHERE id = ?', [currentStudent.id])
      await conn.query('UPDATE students SET openid = ? WHERE id = ?', [currentStudent.openid, targetStudent.id])
    }

    const [[boundStudent]] = await conn.query(
      `SELECT s.id, s.phone, s.name, s.status, sp.avatar_url
       FROM students s
       LEFT JOIN student_profiles sp ON sp.student_id = s.id
       WHERE s.id = ?
       LIMIT 1`,
      [targetStudent.id]
    )

    await conn.commit()

    res.json({
      ...buildStudentAuthPayload(boundStudent),
      bound: true,
    })
  } catch (error) {
    if (conn) await conn.rollback()
    res.status(500).json({ message: '服务器错误', error: error.message })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/student/dev-login', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' })
  }

  const { studentId } = req.body

  try {
    const student = await getStudentAuthRecordById(studentId || 1)

    if (!student) {
      return res.status(404).json({ message: '学生不存在' })
    }

    await ensureStudentVisibleForTeachers(student.id)

    res.json(buildStudentAuthPayload(student))
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

module.exports = router

