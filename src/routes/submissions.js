const router  = require('express').Router()
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const { v4: uuidv4 } = require('uuid')
const pool    = require('../config/db')
const auth    = require('../middleware/auth')
const {
  getFeedbackTaskIdForUploadTask,
  getPreviousTaskIds,
  isUploadTask,
  readMeta,
} = require('../lib/learningPath')
const { normalizeCheckpointName } = require('../lib/checkpoint')
const { UPLOADS_DIR } = require('../lib/uploads')
const { sendGradeNotification } = require('../lib/wxSubscribe')

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

function cleanMetaPatch(patch = {}) {
  return Object.keys(patch).reduce((result, key) => {
    if (patch[key] !== undefined) {
      result[key] = patch[key]
    }
    return result
  }, {})
}

function removeStoredFile(filename = '') {
  const safeName = String(filename || '').trim()
  if (!safeName) return

  const filePath = path.join(UPLOADS_DIR, safeName)
  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, () => {})
  }
}

async function upsertLearningPathTaskMeta({
  studentId,
  pointName,
  stageKey,
  taskId,
  isDone,
  metaPatch = {},
  appendUpload = null,
  actorRole = 'system',
  actorId = null,
}) {
  if (!studentId || !pointName || !stageKey || !taskId) return null

  const [[existingRow]] = await pool.query(
    `SELECT meta_json
     FROM student_learning_path_tasks
     WHERE student_id = ? AND point_name = ? AND stage_key = ? AND task_id = ?
     LIMIT 1`,
    [studentId, pointName, stageKey, taskId]
  )
  const currentMeta = readMeta(existingRow && existingRow.meta_json)
  const nextMeta = {
    ...currentMeta,
    ...cleanMetaPatch(metaPatch),
  }

  if (appendUpload) {
    nextMeta.uploads = [
      ...(Array.isArray(currentMeta.uploads) ? currentMeta.uploads : []),
      appendUpload,
    ]
    nextMeta.uploadCount = nextMeta.uploads.length
  }

  await pool.query(
    `INSERT INTO student_learning_path_tasks (
       student_id, point_name, stage_key, task_id, is_done, meta_json, updated_by_role, updated_by_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       is_done = VALUES(is_done),
       meta_json = VALUES(meta_json),
       updated_by_role = VALUES(updated_by_role),
       updated_by_id = VALUES(updated_by_id),
       updated_at = NOW()`,
    [
      studentId,
      pointName,
      stageKey,
      taskId,
      isDone ? 1 : 0,
      JSON.stringify(nextMeta),
      actorRole,
      actorId,
    ]
  )

  return nextMeta
}

async function getDoneLearningPathTaskIds(studentId, pointName, stageKey) {
  const [rows] = await pool.query(
    `SELECT task_id
     FROM student_learning_path_tasks
     WHERE student_id = ? AND point_name = ? AND stage_key = ? AND is_done = 1`,
    [studentId, pointName, stageKey]
  )
  return new Set(rows.map((row) => row.task_id))
}

async function validateLearningPathUpload(studentId, pointName, stageKey, taskId) {
  if (!pointName || !stageKey || !taskId) return null

  if (!isUploadTask(stageKey, taskId)) {
    return '当前学习路径任务不支持直接上传'
  }

  const doneTaskIds = await getDoneLearningPathTaskIds(studentId, pointName, stageKey)
  const missingPreviousTaskId = getPreviousTaskIds(stageKey, taskId).find((previousTaskId) => !doneTaskIds.has(previousTaskId))
  if (missingPreviousTaskId) {
    return '请先按顺序完成前面的学习路径任务'
  }

  return null
}

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
    pointName = '',
    stageKey = '',
    taskId = '',
    feedbackTaskId = '',
  } = req.body

  const id = uuidv4()
  const now = new Date()
  const submittedAt = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const safePointName = normalizeCheckpointName(pointName || checkpoint)
  const safeStageKey = String(stageKey || '').trim()
  const safeTaskId = String(taskId || '').trim()
  const safeFeedbackTaskId = String(feedbackTaskId || getFeedbackTaskIdForUploadTask(safeTaskId) || '').trim()

  try {
    const validationError = await validateLearningPathUpload(req.user.id, safePointName, safeStageKey, safeTaskId)
    if (validationError) {
      fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
      return res.status(400).json({ error: validationError })
    }

    await pool.query(
      `INSERT INTO pdf_submissions
        (id, student_id, student_name, review_type, checkpoint, deadline, priority, submitted_normal,
         file_name, stored_file, point_name, stage_key, task_id, feedback_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
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
        safePointName || null,
        safeStageKey || null,
        safeTaskId || null,
        safeFeedbackTaskId || null,
      ]
    )

    if (safePointName && safeStageKey && safeTaskId) {
      const uploadMeta = {
        id,
        submissionId: id,
        fileName: req.file.originalname,
        reviewType,
        submittedAt,
        graded: false,
      }
      await upsertLearningPathTaskMeta({
        studentId: req.user.id,
        pointName: safePointName,
        stageKey: safeStageKey,
        taskId: safeTaskId,
        isDone: true,
        metaPatch: {
          uploadedAt: now.toISOString(),
        },
        appendUpload: uploadMeta,
        actorRole: 'student',
        actorId: req.user.id,
      })

      if (safeFeedbackTaskId) {
        await upsertLearningPathTaskMeta({
          studentId: req.user.id,
          pointName: safePointName,
          stageKey: safeStageKey,
          taskId: safeFeedbackTaskId,
          isDone: false,
          metaPatch: {
            result: {
              status: 'pending_review',
              submissionId: id,
              fileName: req.file.originalname,
              reviewType,
              submittedAt,
            },
          },
          actorRole: 'student',
          actorId: req.user.id,
        })
      }
    }

    console.log(`[upload] ${studentName} -> ${id} (${req.file.originalname})`)
    res.json({
      ok: true,
      id,
      submittedAt,
      submission: {
        id,
        fileName: req.file.originalname,
        reviewType,
        checkpoint,
        pointName: safePointName,
        stageKey: safeStageKey,
        taskId: safeTaskId,
        feedbackTaskId: safeFeedbackTaskId,
        graded: false,
        submittedAt,
      },
    })
  } catch (err) {
    fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
    res.status(500).json({ error: err.message })
  }
})

// GET /api/submissions  - 老师获取自己学生的待批改列表
router.get('/', auth('teacher'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ps.id, ps.student_id, ps.student_name, ps.review_type, ps.checkpoint, ps.deadline, ps.priority,
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
    res.json(rows.map((row) => ({
      ...row,
      checkpoint: normalizeCheckpointName(row.checkpoint),
    })))
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

// POST /api/submissions/:id/review-file  - 老师上传批改后 PDF
router.post('/:id/review-file', auth('teacher'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到批改 PDF' })

  const ext = path.extname(req.file.originalname || '').toLowerCase()
  if (ext !== '.pdf') {
    removeStoredFile(req.file.filename)
    return res.status(400).json({ error: '仅支持上传 PDF 文件' })
  }

  try {
    const [[row]] = await pool.query(
      `SELECT ps.id, ps.reviewed_stored_file
       FROM pdf_submissions ps
       JOIN teacher_students ts ON ts.student_id = ps.student_id
       WHERE ps.id = ? AND ts.teacher_id = ?`,
      [req.params.id, req.user.id]
    )

    if (!row) {
      removeStoredFile(req.file.filename)
      return res.status(404).json({ error: '提交记录不存在' })
    }

    if (row.reviewed_stored_file) {
      removeStoredFile(row.reviewed_stored_file)
    }

    await pool.query(
      `UPDATE pdf_submissions
       SET reviewed_file_name = ?, reviewed_stored_file = ?
       WHERE id = ?`,
      [req.file.originalname, req.file.filename, req.params.id]
    )

    res.json({
      ok: true,
      reviewedFileName: req.file.originalname,
    })
  } catch (err) {
    removeStoredFile(req.file.filename)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/submissions/:id/grade  - 老师保存自己学生的批改结果
router.put('/:id/grade', auth('teacher'), async (req, res) => {
  const { score, feedback } = req.body
  try {
    const [[row]] = await pool.query(
      `SELECT ps.id, ps.student_id, ps.student_name, ps.review_type, ps.checkpoint, ps.file_name,
              ps.point_name, ps.stage_key, ps.task_id, ps.feedback_task_id,
              ps.reviewed_file_name, ps.reviewed_stored_file,
              s.openid AS student_openid,
              ts_rel.subject AS course_name
       FROM pdf_submissions ps
       JOIN teacher_students ts_rel ON ts_rel.student_id = ps.student_id AND ts_rel.teacher_id = ?
       JOIN students s ON s.id = ps.student_id
       WHERE ps.id = ?`,
      [req.user.id, req.params.id]
    )
    if (!row) return res.status(404).json({ error: '提交记录不存在' })
    await pool.query(
      'UPDATE pdf_submissions SET graded = 1, score = ?, feedback = ?, graded_at = NOW() WHERE id = ?',
      [score ?? null, feedback ?? null, req.params.id]
    )

    if (row.point_name && row.stage_key && row.feedback_task_id) {
      await upsertLearningPathTaskMeta({
        studentId: row.student_id,
        pointName: row.point_name,
        stageKey: row.stage_key,
        taskId: row.feedback_task_id,
        isDone: false,
        metaPatch: {
          result: {
            status: 'reviewed',
            submissionId: row.id,
            fileName: row.file_name,
            reviewType: row.review_type,
            checkpoint: row.checkpoint,
            score: score ?? null,
            feedback: feedback ?? '',
            gradedAt: new Date().toISOString(),
            reviewedFileName: row.reviewed_file_name || '',
            hasReviewedFile: !!row.reviewed_stored_file,
          },
        },
        actorRole: 'teacher',
        actorId: req.user.id,
      })
    }

    res.json({ ok: true })

    // 批改完成后异步发送订阅消息，不阻塞响应
    sendGradeNotification(row.student_openid, {
      studentName: row.student_name,
      courseName: row.course_name || row.checkpoint || row.review_type,
      taskTitle: row.file_name,
      score: score ?? null,
      page: `/pages/results/results?id=${row.id}`,
    }).catch((err) => console.error('[wxSubscribe] 发送异常:', err.message))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
