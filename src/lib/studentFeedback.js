const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const pool = require('../config/db')

const FEEDBACK_SOURCE_LABELS = {
  recorded_lesson: '录播课反馈',
  find_teacher: '找老师反馈',
}

let ensureTablePromise = null

function ensureStudentFeedbackTable() {
  if (ensureTablePromise) return ensureTablePromise

  ensureTablePromise = pool.query(`
    CREATE TABLE IF NOT EXISTS student_feedback_messages (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      student_id       INT NOT NULL,
      source           ENUM('recorded_lesson','find_teacher') NOT NULL,
      title            VARCHAR(120),
      point_name       VARCHAR(100),
      course_id        INT,
      content          TEXT,
      attachments_json LONGTEXT,
      meta_json        LONGTEXT,
      status           ENUM('pending','read') DEFAULT 'pending',
      reviewed_by      INT,
      reviewed_at      DATETIME,
      created_at       DATETIME DEFAULT NOW(),
      updated_at       DATETIME DEFAULT NOW() ON UPDATE NOW(),
      INDEX idx_feedback_student (student_id),
      INDEX idx_feedback_status (status),
      INDEX idx_feedback_created (created_at),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id) REFERENCES courses(id),
      FOREIGN KEY (reviewed_by) REFERENCES teachers(id)
    )
  `).catch((error) => {
    ensureTablePromise = null
    throw error
  })

  return ensureTablePromise
}

function sanitizeFeedbackSource(value = '') {
  const source = String(value || '').trim()
  return FEEDBACK_SOURCE_LABELS[source] ? source : ''
}

function getFeedbackSourceLabel(source = '') {
  return FEEDBACK_SOURCE_LABELS[source] || '学生反馈'
}

function parseJsonArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return {}

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function resolveAttachmentExt(name = '', mimeType = '') {
  const byName = path.extname(String(name || '').trim())
  if (byName) return byName.slice(0, 10)

  const normalizedMime = String(mimeType || '').toLowerCase()
  if (normalizedMime.includes('png')) return '.png'
  if (normalizedMime.includes('webp')) return '.webp'
  if (normalizedMime.includes('gif')) return '.gif'
  return '.jpg'
}

async function persistFeedbackAttachments(attachments = [], uploadsDir) {
  const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, 6) : []
  if (!safeAttachments.length) return []

  const feedbackDir = path.join(uploadsDir, 'feedback')
  if (!fs.existsSync(feedbackDir)) {
    fs.mkdirSync(feedbackDir, { recursive: true })
  }

  const storedRelativePaths = []

  try {
    return safeAttachments.reduce((result, attachment) => {
      const base64 = String((attachment && attachment.base64) || '').trim()
      if (!base64) return result

      const name = String((attachment && attachment.name) || '').trim() || '反馈截图'
      const mimeType = String((attachment && attachment.mimeType) || '').trim()
      const ext = resolveAttachmentExt(name, mimeType)
      const fileName = `${uuidv4()}${ext}`
      const relativePath = path.posix.join('feedback', fileName)
      const fullPath = path.join(uploadsDir, relativePath)
      const buffer = Buffer.from(base64, 'base64')

      fs.writeFileSync(fullPath, buffer)
      storedRelativePaths.push(fullPath)
      result.push({
        name,
        mimeType,
        size: buffer.length,
        url: `/uploads/${relativePath}`,
        storedFile: relativePath,
      })
      return result
    }, [])
  } catch (error) {
    storedRelativePaths.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath)
      } catch {
        // ignore cleanup failure
      }
    })
    throw error
  }
}

function normalizeFeedbackMeta(rawMeta = {}) {
  const meta = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
    ? rawMeta
    : {}

  return {
    videoTitle: String(meta.videoTitle || '').trim().slice(0, 120),
    recordedDoneCount: Math.max(0, Number(meta.recordedDoneCount) || 0),
    recordedTasksTotal: Math.max(0, Number(meta.recordedTasksTotal) || 0),
    ratingScore: Math.max(0, Number(meta.ratingScore) || 0),
    ratedAt: String(meta.ratedAt || '').trim().slice(0, 50),
    ratingTaskId: String(meta.ratingTaskId || '').trim().slice(0, 100),
    stageKey: String(meta.stageKey || '').trim().slice(0, 30),
    lessonTitle: String(meta.lessonTitle || '').trim().slice(0, 160),
    questionTitle: String(meta.questionTitle || '').trim().slice(0, 200),
    knowledgeTitle: String(meta.knowledgeTitle || '').trim().slice(0, 120),
    roundNumber: Math.max(0, Number(meta.roundNumber) || 0),
  }
}

function mapStudentFeedbackRow(row = {}) {
  return {
    id: String(row.id || ''),
    studentId: String(row.student_id || ''),
    studentName: String(row.student_name || ''),
    studentPhone: String(row.student_phone || ''),
    source: sanitizeFeedbackSource(row.source) || 'find_teacher',
    sourceLabel: getFeedbackSourceLabel(row.source),
    title: String(row.title || ''),
    pointName: String(row.point_name || ''),
    courseId: row.course_id ? String(row.course_id) : '',
    content: String(row.content || ''),
    attachments: parseJsonArray(row.attachments_json).map((item, index) => ({
      id: String(item.id || item.storedFile || index + 1),
      name: String(item.name || `附件 ${index + 1}`),
      mimeType: String(item.mimeType || ''),
      url: String(item.url || ''),
      size: Number(item.size || 0),
    })),
    meta: parseJsonObject(row.meta_json),
    status: row.status === 'read' ? 'read' : 'pending',
    reviewedAt: row.reviewed_at || null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : '',
    createdAt: row.created_at || null,
  }
}

async function upsertRatingFeedback({
  studentId,
  pointName = '',
  title = '',
  score = 0,
  ratedAt = '',
  taskId = '',
  stageKey = '',
  lessonTitle = '',
  questionTitle = '',
  knowledgeTitle = '',
  roundNumber = 0,
}) {
  const normalizedScore = Math.max(0, Math.min(5, Number(score) || 0))
  if (!studentId || !normalizedScore) {
    return null
  }

  await ensureStudentFeedbackTable()

  const safeTitle = String(title || '').trim().slice(0, 120)
  const safePointName = String(pointName || '').trim().slice(0, 100)
  const safeTaskId = String(taskId || '').trim().slice(0, 100)
  const meta = normalizeFeedbackMeta({
    videoTitle: safeTitle,
    ratingScore: normalizedScore,
    ratedAt: ratedAt || new Date().toISOString(),
    ratingTaskId: safeTaskId,
    stageKey,
    lessonTitle,
    questionTitle,
    knowledgeTitle,
    roundNumber,
  })
  const safeLessonTitle = meta.lessonTitle || safeTitle
  const shouldShowLessonTitle = safeLessonTitle && safeLessonTitle !== meta.questionTitle
  const contextText = [
    safePointName,
    meta.roundNumber ? `第${meta.roundNumber}节` : '',
    shouldShowLessonTitle ? safeLessonTitle : '',
    meta.questionTitle ? `题目：${meta.questionTitle}` : safeLessonTitle,
  ].filter(Boolean).join(' / ')
  const content = contextText
    ? `${contextText}：课程星级评价 ${normalizedScore} 星`
    : `课程星级评价：${normalizedScore} 星`

  const [[existing]] = await pool.query(
    `SELECT id
     FROM student_feedback_messages
     WHERE student_id = ?
       AND source = 'recorded_lesson'
       AND COALESCE(point_name, '') = ?
       AND COALESCE(title, '') = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(COALESCE(meta_json, '{}'), '$.ratingTaskId')) = ?
     ORDER BY id DESC
     LIMIT 1`,
    [studentId, safePointName, safeTitle, safeTaskId]
  )

  if (existing && existing.id) {
    await pool.query(
      `UPDATE student_feedback_messages
       SET content = ?, meta_json = ?, status = 'pending', reviewed_by = NULL, reviewed_at = NULL
       WHERE id = ?`,
      [content, JSON.stringify(meta), existing.id]
    )
    return existing.id
  }

  const [result] = await pool.query(
    `INSERT INTO student_feedback_messages (
       student_id, source, title, point_name, course_id, content,
       attachments_json, meta_json, status
     ) VALUES (?, 'recorded_lesson', ?, ?, NULL, ?, '[]', ?, 'pending')`,
    [studentId, safeTitle || null, safePointName || null, content, JSON.stringify(meta)]
  )

  return result.insertId
}

module.exports = {
  ensureStudentFeedbackTable,
  getFeedbackSourceLabel,
  mapStudentFeedbackRow,
  normalizeFeedbackMeta,
  parseJsonObject,
  persistFeedbackAttachments,
  sanitizeFeedbackSource,
  upsertRatingFeedback,
}
