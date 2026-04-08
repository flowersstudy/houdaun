const router = require('express').Router()
const pool = require('../config/db')
const auth = require('../middleware/auth')

router.use(auth('teacher'))

// 任务数量概览
router.get('/tasks/count', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [[pendingClass]] = await pool.query(
      'SELECT COUNT(*) as count FROM calendar_events WHERE teacher_id = ? AND date >= CURDATE() AND link IS NULL',
      [teacherId])
    const [[pendingGrade]] = await pool.query(
      'SELECT COUNT(*) as count FROM pdf_submissions WHERE graded = 0')
    const [[newStudents]] = await pool.query(
      `SELECT COUNT(*) as count FROM teacher_students ts
       JOIN students s ON ts.student_id = s.id
       WHERE ts.teacher_id = ? AND s.status = 'new'`,
      [teacherId])
    const [[abnormal]] = await pool.query(
      'SELECT COUNT(*) as count FROM student_flags WHERE teacher_id = ? AND flagged = 1',
      [teacherId])
    res.json({
      pendingClass: pendingClass.count,
      pendingGrade: pendingGrade.count,
      newStudents: newStudents.count,
      abnormal: abnormal.count,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 异常学生列表（必须在 /students/:studentId 之前定义）
router.get('/students/abnormal', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.status, sf.reason, sf.severity, sf.updated_at
       FROM student_flags sf
       JOIN students s ON sf.student_id = s.id
       WHERE sf.teacher_id = ? AND sf.flagged = 1
       ORDER BY FIELD(sf.severity,'high','medium','low'), sf.updated_at DESC`,
      [teacherId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 学生列表
router.get('/students', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.name, s.status, ts.subject, ts.grade,
             MAX(ce.date) as last_session_date
      FROM teacher_students ts
      JOIN students s ON ts.student_id = s.id
      LEFT JOIN calendar_events ce ON ce.teacher_id = ? AND ce.student_id = s.id
      WHERE ts.teacher_id = ?
      GROUP BY s.id, s.name, s.status, ts.subject, ts.grade
    `, [teacherId, teacherId])
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 学生备注和标记（含课程进度）
router.get('/students/:studentId/info', async (req, res) => {
  const { studentId } = req.params
  const teacherId = req.user.id
  try {
    const [notes] = await pool.query(
      'SELECT * FROM student_notes WHERE teacher_id = ? AND student_id = ? ORDER BY created_at DESC',
      [teacherId, studentId]
    )
    const [[flag]] = await pool.query(
      'SELECT flagged, reason, severity FROM student_flags WHERE teacher_id = ? AND student_id = ?',
      [teacherId, studentId]
    )
    const [courses] = await pool.query(
      `SELECT sc.id, c.name, c.subject, sc.progress, sc.status
       FROM student_courses sc JOIN courses c ON sc.course_id = c.id
       WHERE sc.student_id = ?`,
      [studentId]
    )
    res.json({
      notes,
      flagged: flag?.flagged ?? false,
      flagReason: flag?.reason ?? null,
      flagSeverity: flag?.severity ?? null,
      courses,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 添加备注
router.post('/students/:studentId/notes', async (req, res) => {
  const { studentId } = req.params
  const { content } = req.body
  const teacherId = req.user.id
  try {
    await pool.query(
      'INSERT INTO student_notes (teacher_id, student_id, content, author) VALUES (?, ?, ?, ?)',
      [teacherId, studentId, content, req.user.name]
    )
    res.json({ message: '添加成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 删除备注
router.delete('/notes/:noteId', async (req, res) => {
  try {
    await pool.query('DELETE FROM student_notes WHERE id = ? AND teacher_id = ?',
      [req.params.noteId, req.user.id])
    res.json({ message: '删除成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 标记异常学生（支持 reason 和 severity）
router.put('/students/:studentId/flag', async (req, res) => {
  const { flagged, reason, severity } = req.body
  const { studentId } = req.params
  const teacherId = req.user.id
  try {
    await pool.query(
      `INSERT INTO student_flags (teacher_id, student_id, flagged, reason, severity)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE flagged = ?, reason = ?, severity = ?, updated_at = NOW()`,
      [teacherId, studentId, flagged, reason || null, severity || 'medium',
       flagged, reason || null, severity || 'medium']
    )
    res.json({ message: '更新成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 日历列表
router.get('/calendar', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(
      'SELECT * FROM calendar_events WHERE teacher_id = ? ORDER BY date, start_time',
      [teacherId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 新增日历事件
router.post('/calendar', async (req, res) => {
  const { title, date, start_time, end_time, type, student_id } = req.body
  try {
    const [result] = await pool.query(
      'INSERT INTO calendar_events (teacher_id, student_id, title, date, start_time, end_time, type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, student_id || null, title, date, start_time, end_time, type]
    )
    res.json({ id: result.insertId, message: '添加成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 更新日历事件
router.put('/calendar/:eventId', async (req, res) => {
  const { title, date, start_time, end_time, type } = req.body
  try {
    await pool.query(
      'UPDATE calendar_events SET title = ?, date = ?, start_time = ?, end_time = ?, type = ? WHERE id = ? AND teacher_id = ?',
      [title, date, start_time, end_time, type, req.params.eventId, req.user.id]
    )
    res.json({ message: '更新成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 上传课程链接
router.put('/calendar/:eventId/link', async (req, res) => {
  const { link } = req.body
  try {
    await pool.query(
      'UPDATE calendar_events SET link = ? WHERE id = ? AND teacher_id = ?',
      [link, req.params.eventId, req.user.id]
    )
    res.json({ message: '更新成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 删除日历事件
router.delete('/calendar/:eventId', async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM calendar_events WHERE id = ? AND teacher_id = ?',
      [req.params.eventId, req.user.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ message: '事件不存在或无权删除' })
    res.json({ message: '删除成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 联系人备注（contact_notes）
router.get('/contacts/:contactId/notes', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM contact_notes WHERE teacher_id = ? AND contact_id = ? ORDER BY created_at ASC',
      [req.user.id, req.params.contactId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/contacts/:contactId/notes', async (req, res) => {
  const { text } = req.body
  try {
    const [result] = await pool.query(
      'INSERT INTO contact_notes (teacher_id, contact_id, author_name, text) VALUES (?, ?, ?, ?)',
      [req.user.id, req.params.contactId, req.user.name, text]
    )
    res.json({ id: result.insertId, message: '添加成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.delete('/contact-notes/:noteId', async (req, res) => {
  try {
    await pool.query('DELETE FROM contact_notes WHERE id = ? AND teacher_id = ?',
      [req.params.noteId, req.user.id])
    res.json({ message: '删除成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

module.exports = router
