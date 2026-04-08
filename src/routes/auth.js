const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const axios = require('axios')
const pool = require('../config/db')

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

  try {
    const [existing] = await pool.query('SELECT id FROM teachers WHERE email = ?', [email])
    if (existing.length > 0) {
      return res.status(409).json({ message: '该邮箱已注册' })
    }

    const hash = await bcrypt.hash(password, 10)
    const [result] = await pool.query(
      'INSERT INTO teachers (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, hash]
    )

    const token = jwt.sign(
      { id: result.insertId, role: 'teacher', name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({ token, name, id: result.insertId })
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

router.post('/student/wx-login', async (req, res) => {
  const { code } = req.body

  if (!code) {
    return res.status(400).json({ message: '缺少微信登录 code' })
  }

  if (!process.env.WX_APPID || !process.env.WX_SECRET) {
    return res.status(500).json({ message: '未配置微信登录参数，请检查 WX_APPID 和 WX_SECRET' })
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
      const message = data.errcode === 40125
        ? '微信登录失败，请检查后端 WX_APPID/WX_SECRET 是否正确'
        : '微信登录失败'
      return res.status(400).json({ message, errcode: data.errcode })
    }

    const { openid } = data
    let [rows] = await pool.query('SELECT * FROM students WHERE openid = ?', [openid])
    let student = rows[0]

    if (!student) {
      const [result] = await pool.query(
        'INSERT INTO students (openid, name, status) VALUES (?, ?, ?)',
        [openid, '新学员', 'new']
      )
      student = { id: result.insertId, openid, name: '新学员', status: 'new' }
    }

    const token = jwt.sign(
      { id: student.id, role: 'student', name: student.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({ token, name: student.name, id: student.id, status: student.status })
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

router.post('/student/dev-login', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' })
  }

  const { studentId } = req.body

  try {
    const [rows] = await pool.query('SELECT * FROM students WHERE id = ?', [studentId || 1])
    const student = rows[0]

    if (!student) {
      return res.status(404).json({ message: '学生不存在' })
    }

    const token = jwt.sign(
      { id: student.id, role: 'student', name: student.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({ token, name: student.name, id: student.id, status: student.status })
  } catch (error) {
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

module.exports = router
