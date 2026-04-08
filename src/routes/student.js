const router = require('express').Router()
const pool = require('../config/db')
const auth = require('../middleware/auth')

router.use(auth('student'))

// 首页课程进度
router.get('/profile', async (req, res) => {
  const studentId = req.user.id
  try {
    const [inProgress] = await pool.query(`
      SELECT sc.id, c.name, c.subject, sc.progress, sc.status
      FROM student_courses sc JOIN courses c ON sc.course_id = c.id
      WHERE sc.student_id = ? AND sc.status != 'completed'
    `, [studentId])
    const [completed] = await pool.query(`
      SELECT sc.id, c.name, c.subject, sc.progress, sc.status
      FROM student_courses sc JOIN courses c ON sc.course_id = c.id
      WHERE sc.student_id = ? AND sc.status = 'completed'
    `, [studentId])
    res.json({ inProgress, completed })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 学习计划
router.get('/study/:courseId', async (req, res) => {
  const { courseId } = req.params
  const studentId = req.user.id
  try {
    const [[course]] = await pool.query(
      `SELECT sc.progress, sc.status, c.name FROM student_courses sc
       JOIN courses c ON sc.course_id = c.id
       WHERE sc.student_id = ? AND sc.course_id = ?`,
      [studentId, courseId]
    )
    if (!course) return res.status(404).json({ message: '未找到课程' })

    const [days] = await pool.query(
      'SELECT * FROM study_days WHERE student_id = ? AND course_id = ? ORDER BY day_number',
      [studentId, courseId]
    )
    for (const day of days) {
      const [tasks] = await pool.query(
        'SELECT * FROM study_tasks WHERE study_day_id = ? ORDER BY sort_order',
        [day.id]
      )
      day.tasks = tasks
    }
    res.json({ course, days })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 完成任务
router.put('/study/tasks/:taskId/complete', async (req, res) => {
  try {
    await pool.query('UPDATE study_tasks SET completed = 1 WHERE id = ?', [req.params.taskId])
    res.json({ message: '已完成' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 复盘
router.get('/review', async (req, res) => {
  const studentId = req.user.id
  try {
    const [reviews] = await pool.query(
      'SELECT * FROM reviews WHERE student_id = ? ORDER BY created_at DESC LIMIT 1',
      [studentId]
    )
    const review = reviews[0]
    if (!review) return res.json(null)
    const [items] = await pool.query(
      'SELECT * FROM review_items WHERE review_id = ? ORDER BY type, sort_order',
      [review.id]
    )
    res.json({ ...review, items })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 纲要
router.get('/outline/:courseId', async (req, res) => {
  const { courseId } = req.params
  const studentId = req.user.id
  try {
    const [outlineItems] = await pool.query(
      'SELECT * FROM outline_items WHERE student_id = ? AND course_id = ? ORDER BY type, sort_order',
      [studentId, courseId]
    )
    res.json({ outlineItems })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 课程列表
router.get('/courses', async (req, res) => {
  try {
    const [courses] = await pool.query('SELECT * FROM courses WHERE is_active = 1')
    res.json(courses)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 提交请假申请
router.post('/leave', async (req, res) => {
  const studentId = req.user.id
  const { type, courseId, pointName, stepName, days, reason } = req.body
  try {
    // 检查同一卡点是否超过2次请假
    if (courseId) {
      const [[leaveCount]] = await pool.query(
        `SELECT COUNT(*) as count FROM leave_requests
         WHERE student_id = ? AND course_id = ? AND status != 'rejected'`,
        [studentId, courseId]
      )
      if (leaveCount.count >= 2) {
        return res.status(400).json({ message: '该卡点请假次数已达上限（2次）' })
      }
    }
    const [result] = await pool.query(
      `INSERT INTO leave_requests (student_id, type, course_id, point_name, step_name, days, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [studentId, type || 'single', courseId || null, pointName || '', stepName || '', days || 1, reason || '']
    )
    res.json({ id: result.insertId, status: 'pending', message: '请假申请已提交' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 获取请假记录
router.get('/leave', async (req, res) => {
  const studentId = req.user.id
  try {
    const [rows] = await pool.query(
      'SELECT * FROM leave_requests WHERE student_id = ? ORDER BY created_at DESC',
      [studentId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 审批请假（自动审批 / 老师审批）
router.patch('/leave/:id/approve', async (req, res) => {
  try {
    await pool.query(
      "UPDATE leave_requests SET status = 'approved', approved_at = NOW() WHERE id = ?",
      [req.params.id]
    )
    res.json({ message: '已审批' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 取消请假
router.delete('/leave/:id', async (req, res) => {
  const studentId = req.user.id
  try {
    const [result] = await pool.query(
      "DELETE FROM leave_requests WHERE id = ? AND student_id = ? AND status = 'pending'",
      [req.params.id, studentId]
    )
    if (result.affectedRows === 0) return res.status(400).json({ message: '申请不存在或已审批，无法取消' })
    res.json({ message: '已取消' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

module.exports = router
