const router  = require('express').Router()
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const { v4: uuidv4 } = require('uuid')
const pool    = require('../config/db')
const auth    = require('../middleware/auth')

const UPLOADS_DIR = path.join(__dirname, '../../uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf'
    cb(null, `${uuidv4()}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
})

// POST /api/submissions  - 学生上传
router.post('/', auth('student'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' })

  const {
    studentName = req.user.name,
    reviewType = '卡点练习题',
    checkpoint = '',
    deadline = '',
    priority = 'normal',
    submittedNormal = 'true',
  } = req.body

  const id = uuidv4()
  const now = new Date()
  const submittedAt = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  try {
    await pool.query(
      `INSERT INTO pdf_submissions
        (id, student_id, student_name, review_type, checkpoint, deadline, priority, submitted_normal, file_name, stored_file, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        req.user.id,
        studentName,
        reviewType,
        checkpoint,
        deadline,
        priority,
        submittedNormal === 'true' ? 1 : 0,
        req.file.originalname,
        req.file.filename,
      ]
    )
    console.log(`[upload] ${studentName} -> ${id} (${req.file.originalname})`)
    res.json({ ok: true, id, submittedAt })
  } catch (err) {
    fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
    res.status(500).json({ error: err.message })
  }
})

// GET /api/submissions  - 老师获取自己学生的待批改列表
router.get('/', auth('teacher'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ps.id, ps.student_name, ps.review_type, ps.checkpoint, ps.deadline, ps.priority,
              ps.submitted_normal, ps.file_name,
              DATE_FORMAT(ps.created_at,'%m-%d %H:%i') AS submitted_at
       FROM pdf_submissions ps
       JOIN teacher_students ts ON ts.student_id = ps.student_id
       WHERE ps.graded = 0 AND ts.teacher_id = ?
       ORDER BY
         FIELD(ps.priority,'urgent','normal','low'),
         ps.created_at ASC`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/submissions/file/:id  - 老师获取自己学生的 PDF 文件
router.get('/file/:id', auth('teacher'), async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT ps.file_name, ps.stored_file
       FROM pdf_submissions ps
       JOIN teacher_students ts ON ts.student_id = ps.student_id
       WHERE ps.id = ? AND ts.teacher_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!row) return res.status(404).json({ error: 'not found' })
    const filePath = path.join(UPLOADS_DIR, row.stored_file)
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file missing' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name)}"`)
    fs.createReadStream(filePath).pipe(res)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/submissions/:id/grade  - 老师保存自己学生的批改结果
router.put('/:id/grade', auth('teacher'), async (req, res) => {
  const { score, feedback } = req.body
  try {
    const [[row]] = await pool.query(
      `SELECT ps.id
       FROM pdf_submissions ps
       JOIN teacher_students ts ON ts.student_id = ps.student_id
       WHERE ps.id = ? AND ts.teacher_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!row) return res.status(404).json({ error: '提交记录不存在' })
    await pool.query(
      'UPDATE pdf_submissions SET graded = 1, score = ?, feedback = ?, graded_at = NOW() WHERE id = ?',
      [score ?? null, feedback ?? null, req.params.id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
