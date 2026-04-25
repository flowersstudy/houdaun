const router = require('express').Router()
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const {
  buildLearningPathPayload,
  findTaskDefinition,
  getPreviousTaskIds,
  getUploadTaskIdForFeedbackTask,
  isFeedbackTask,
  isUploadTask,
  readMeta,
  summarizeLearningPathProgress,
} = require('../lib/learningPath')
const {
  ensureStudentFeedbackTable,
  normalizeFeedbackMeta,
  persistFeedbackAttachments,
  sanitizeFeedbackSource,
  upsertRatingFeedback,
} = require('../lib/studentFeedback')
const { normalizeCheckpointName } = require('../lib/checkpoint')
const { UPLOADS_DIR } = require('../lib/uploads')

router.use(auth('student'))

const POLYV_PLAY_AUTH_URL = String(process.env.POLYV_PLAY_AUTH_URL || 'https://api.yaotia.cn/web/polyv/getToken').trim()
const POLYV_PLAY_AUTH_METHOD = String(process.env.POLYV_PLAY_AUTH_METHOD || 'GET').trim().toUpperCase()
const POLYV_USER_ID = String(process.env.POLYV_USER_ID || '').trim()
const POLYV_SECRET_KEY = String(process.env.POLYV_SECRET_KEY || '').trim()

const REVIEW_POINT_LIST = [
  { id: 1, pointName: '\u8981\u70b9\u4e0d\u5168\u4e0d\u51c6' },
  { id: 2, pointName: '\u63d0\u70bc\u8f6c\u8ff0\u56f0\u96be' },
  { id: 3, pointName: '\u5206\u6790\u7ed3\u6784\u4e0d\u6e05' },
  { id: 4, pointName: '\u516c\u6587\u7ed3\u6784\u4e0d\u6e05' },
  { id: 5, pointName: '\u5bf9\u7b56\u63a8\u5bfc\u56f0\u96be' },
  { id: 6, pointName: '\u4f5c\u6587\u7acb\u610f\u4e0d\u51c6' },
  { id: 7, pointName: '\u4f5c\u6587\u8bba\u8bc1\u4e0d\u6e05' },
  { id: 8, pointName: '\u4f5c\u6587\u8868\u8fbe\u4e0d\u7545' },
]

const REVIEW_POINT_STATUS_PRIORITY = {
  learning: 0,
  completed: 1,
  assigned: 2,
  locked: 3,
}

function createMd5(value = '') {
  return crypto.createHash('md5').update(String(value)).digest('hex')
}

function normalizeIpv4(value = '') {
  const source = String(value || '').trim()
  if (!source) return ''
  const firstIp = source.split(',')[0].trim()
  return firstIp.replace(/^::ffff:/i, '')
}

function getRequestIp(req) {
  return normalizeIpv4(
    req.headers['x-forwarded-for']
    || req.headers['x-real-ip']
    || (req.socket && req.socket.remoteAddress)
    || req.ip
    || ''
  )
}

function normalizePolyvPlayAuthPayload(payload = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {}
  const data = safePayload.data && typeof safePayload.data === 'object'
    ? safePayload.data
    : safePayload

  return {
    playsafe: String(data.playsafe || '').trim(),
    ts: Number(data.ts) || 0,
    sign: String(data.sign || '').trim(),
  }
}

async function requestPolyvPlayAuthFromProxy(videoId) {
  if (!POLYV_PLAY_AUTH_URL) return null

  const payload = { vid: videoId }

  const response = POLYV_PLAY_AUTH_METHOD === 'GET'
    ? await axios.get(POLYV_PLAY_AUTH_URL, { params: payload, timeout: 10000, proxy: false })
    : await axios({
        url: POLYV_PLAY_AUTH_URL,
        method: POLYV_PLAY_AUTH_METHOD || 'POST',
        data: payload,
        timeout: 10000,
        proxy: false,
      })

  return normalizePolyvPlayAuthPayload(response && response.data)
}

async function requestPolyvPlayAuthDirect(videoId, req) {
  if (!POLYV_USER_ID || !POLYV_SECRET_KEY) return null

  const ts = Date.now()
  const sign = createMd5(`${POLYV_USER_ID}${videoId}${ts}${POLYV_SECRET_KEY}`)
  const body = new URLSearchParams({
    userId: POLYV_USER_ID,
    videoId,
    ts: String(ts),
    sign,
    viewerId: String(req.user.id || ''),
    viewerName: String(req.user.name || `student_${req.user.id || ''}`),
    viewerIp: getRequestIp(req) || '127.0.0.1',
  })

  const response = await axios.post(
    'https://hls.videocc.net/service/v1/token',
    body.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
      proxy: false,
    }
  )

  const normalized = normalizePolyvPlayAuthPayload(response && response.data)
  return {
    playsafe: normalized.playsafe,
    ts,
    sign,
  }
}

async function getPolyvPlayAuth(videoId, req) {
  const fromProxy = await requestPolyvPlayAuthFromProxy(videoId).catch(() => null)
  if (fromProxy && fromProxy.playsafe) {
    return fromProxy
  }

  const direct = await requestPolyvPlayAuthDirect(videoId, req).catch(() => null)
  if (direct && direct.playsafe) {
    return direct
  }

  return null
}

function isMissingTableError(error) {
  return error && error.code === 'ER_NO_SUCH_TABLE'
}

function getTheoryRatingContext(learningPathRows = [], taskId = '') {
  const match = String(taskId || '').match(/^theory_round_(\d+)_/)
  if (!match) return {}

  const roundNumber = Number(match[1]) || 0
  const configRow = learningPathRows.find((row) => (
    row.stage_key === 'theory_config'
    && row.task_id === 'assignment_config'
  ))
  const configMeta = readMeta(configRow && configRow.meta_json)
  const theoryLessons = Array.isArray(configMeta.theoryLessons) ? configMeta.theoryLessons : []
  const lesson = theoryLessons[roundNumber - 1]

  if (!lesson || typeof lesson !== 'object') {
    return { roundNumber }
  }

  return {
    roundNumber,
    lessonTitle: String(lesson.title || '').trim(),
    questionTitle: String(lesson.noteText || lesson.title || lesson.knowledgeTitle || lesson.scope || '').trim(),
    knowledgeTitle: String(lesson.knowledgeTitle || '').trim(),
  }
}

function mergeLearningPathMeta(previousMeta = {}, patch = {}) {
  const nextMeta = {
    ...previousMeta,
    ...patch,
  }

  if (patch.appointment && typeof patch.appointment === 'object') {
    nextMeta.appointment = {
      ...(previousMeta.appointment || {}),
      ...patch.appointment,
    }
  }

  if (patch.rating && typeof patch.rating === 'object') {
    nextMeta.rating = {
      ...(previousMeta.rating || {}),
      ...patch.rating,
    }
  }

  if (patch.result && typeof patch.result === 'object') {
    nextMeta.result = {
      ...(previousMeta.result || {}),
      ...patch.result,
    }
  }

  if (patch.resource && typeof patch.resource === 'object') {
    nextMeta.resource = {
      ...(previousMeta.resource || {}),
      ...patch.resource,
    }
  }

  if (Array.isArray(patch.uploads)) {
    nextMeta.uploads = patch.uploads
  }

  return nextMeta
}

async function loadLearningPathRows(studentId, pointName, executor = pool) {
  const [rows] = await executor.query(
    `SELECT id, stage_key, task_id, is_done, meta_json, updated_at
     FROM student_learning_path_tasks
     WHERE student_id = ? AND point_name = ?
     ORDER BY id ASC`,
    [studentId, pointName]
  )
  return rows
}

async function buildStudentLearningPath(studentId, pointName) {
  const safePointName = normalizeCheckpointName(pointName)
  const rows = await loadLearningPathRows(studentId, safePointName)

  // buildLearningPathPayload 内部的 decorateTask 会从 meta_json 的 liveUrl/replayUrl 注入 resource
  const payload = buildLearningPathPayload(studentId, safePointName, rows.map((row) => ({
    ...row,
    status: Number(row.is_done) ? 'done' : 'pending',
  })))

  return payload
}

async function syncStudentCourseProgress(studentId, pointName, executor = pool) {
  const safePointName = normalizeCheckpointName(pointName)
  const [[course]] = await executor.query(
    `SELECT c.id
     FROM student_courses sc
     JOIN courses c ON c.id = sc.course_id
     WHERE sc.student_id = ? AND c.name = ?
     LIMIT 1`,
    [studentId, safePointName]
  )
  if (!course) {
    return null
  }

  const rows = await loadLearningPathRows(studentId, safePointName, executor)
  const summary = summarizeLearningPathProgress(studentId, safePointName, rows.map((row) => ({
    ...row,
    status: Number(row.is_done) ? 'done' : 'pending',
  })))
  const courseStatus = summary.allDone ? 'completed' : 'in_progress'

  await executor.query(
    `UPDATE student_courses
     SET progress = ?, status = ?
     WHERE student_id = ? AND course_id = ?`,
    [summary.progressPercent, courseStatus, studentId, course.id]
  )

  return {
    progress: summary.progressPercent,
    status: courseStatus,
  }
}

async function syncAllStudentCourseProgress(studentId, executor = pool) {
  const [rows] = await executor.query(
    `SELECT DISTINCT point_name
     FROM student_learning_path_tasks
     WHERE student_id = ?
       AND point_name IS NOT NULL
       AND point_name != ''`,
    [studentId]
  )

  for (const row of rows) {
    await syncStudentCourseProgress(studentId, row.point_name, executor)
  }
}

async function saveLearningPathTask({
  studentId,
  pointName,
  stageKey,
  taskId,
  status,
  metaPatch,
  actorRole,
  actorId,
}) {
  const safePointName = normalizeCheckpointName(pointName)
  const [[existingRow]] = await pool.query(
    `SELECT id, meta_json, is_done
     FROM student_learning_path_tasks
     WHERE student_id = ? AND point_name = ? AND stage_key = ? AND task_id = ?
     LIMIT 1`,
    [studentId, safePointName, stageKey, taskId]
  )

  let mergedMeta = mergeLearningPathMeta({}, metaPatch)
  if (existingRow && existingRow.meta_json) {
    try {
      const parsedMeta = JSON.parse(existingRow.meta_json)
      mergedMeta = mergeLearningPathMeta(parsedMeta && typeof parsedMeta === 'object' ? parsedMeta : {}, metaPatch)
    } catch {
      mergedMeta = mergeLearningPathMeta({}, metaPatch)
    }
  }

  const nextDone = status === 'pending' || status === 'current'
    ? 0
    : 1

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
      safePointName,
      stageKey,
      taskId,
      nextDone,
      JSON.stringify(mergedMeta),
      actorRole,
      actorId,
    ]
  )

  await syncStudentCourseProgress(studentId, safePointName)

  return {
    pointName: safePointName,
    taskId,
    stageKey,
    status: nextDone ? 'done' : 'pending',
    updatedAt: new Date().toISOString(),
  }
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

async function hasGradedSubmissionForFeedbackTask(studentId, pointName, stageKey, feedbackTaskId) {
  if (!studentId || !pointName || !stageKey || !feedbackTaskId) return false

  const uploadTaskId = getUploadTaskIdForFeedbackTask(feedbackTaskId)
  const params = [studentId, pointName, stageKey, feedbackTaskId]
  let taskCondition = ''

  if (uploadTaskId) {
    taskCondition = ' OR task_id = ?'
    params.push(uploadTaskId)
  }

  const [[row]] = await pool.query(
    `SELECT id
     FROM pdf_submissions
     WHERE student_id = ?
       AND point_name = ?
       AND stage_key = ?
       AND graded = 1
       AND (feedback_task_id = ?${taskCondition})
     ORDER BY graded_at DESC, created_at DESC
     LIMIT 1`,
    params
  )

  return !!row
}

async function validateStudentLearningPathPatch({
  studentId,
  pointName,
  stageKey,
  taskId,
  status,
  learningPathRows = [],
}) {
  if (status === 'pending' || status === 'current') {
    return null
  }

  if (isUploadTask(stageKey, taskId, learningPathRows)) {
    return '\u8bf7\u901a\u8fc7\u4e0a\u4f20\u5165\u53e3\u63d0\u4ea4 PDF\uff0c\u4e0d\u80fd\u76f4\u63a5\u5b8c\u6210\u4e0a\u4f20\u4efb\u52a1'
  }

  const doneTaskIds = await getDoneLearningPathTaskIds(studentId, pointName, stageKey)
  const missingPreviousTaskId = getPreviousTaskIds(stageKey, taskId, learningPathRows).find((previousTaskId) => !doneTaskIds.has(previousTaskId))
  if (missingPreviousTaskId) {
    return '\u8bf7\u5148\u6309\u987a\u5e8f\u5b8c\u6210\u524d\u9762\u7684\u5b66\u4e60\u8def\u5f84\u4efb\u52a1'
  }

  // diagnose_feedback 是学生自填问卷，不需要老师批改，跳过批改检查
  const isSelfFeedback = taskId === 'diagnose_feedback'
  if (!isSelfFeedback && isFeedbackTask(stageKey, taskId, learningPathRows)) {
    const hasResult = await hasGradedSubmissionForFeedbackTask(studentId, pointName, stageKey, taskId)
    if (!hasResult) {
      return '\u8001\u5e08\u8fd8\u6ca1\u6709\u5b8c\u6210\u6279\u6539\uff0c\u6682\u65f6\u4e0d\u80fd\u5b8c\u6210\u53cd\u9988\u4efb\u52a1'
    }
  }

  return null
}

function formatSubmission(row = {}) {
  const meta = readMeta(row.meta_json)

  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    reviewType: row.review_type,
    checkpoint: normalizeCheckpointName(row.checkpoint),
    deadline: row.deadline || '',
    priority: row.priority || 'normal',
    submittedNormal: Number(row.submitted_normal) === 1,
    fileName: row.file_name,
    pointName: row.point_name || normalizeCheckpointName(row.checkpoint),
    stageKey: row.stage_key || '',
    taskId: row.task_id || '',
    feedbackTaskId: row.feedback_task_id || '',
    graded: Number(row.graded) === 1,
    score: row.score,
    feedback: row.feedback || '',
    gradedAt: row.graded_at,
    reviewedFileName: row.reviewed_file_name || '',
    hasReviewedFile: !!row.reviewed_stored_file,
    submittedAt: row.created_at,
    meta,
  }
}

function resolveReviewPointStatus(courseStatus = '') {
  const safeStatus = String(courseStatus || '').trim()

  if (safeStatus === 'completed') return 'completed'
  if (safeStatus === 'pending' || safeStatus === 'not_started') return 'assigned'
  if (!safeStatus || safeStatus === 'failed' || safeStatus === 'aborted') return 'locked'

  return 'learning'
}

function applyReviewPointStatus(statusMap = {}, pointName = '', nextStatus = 'locked') {
  if (!pointName || !statusMap[pointName]) return

  const currentStatus = statusMap[pointName].status || 'locked'
  if ((REVIEW_POINT_STATUS_PRIORITY[nextStatus] || 99) < (REVIEW_POINT_STATUS_PRIORITY[currentStatus] || 99)) {
    statusMap[pointName].status = nextStatus
  }
}

async function getReviewPointStatuses(studentId) {
  const statusMap = REVIEW_POINT_LIST.reduce((result, item) => {
    result[item.pointName] = { ...item, status: 'locked' }
    return result
  }, {})

  const [courseRows] = await pool.query(
    `SELECT c.name AS pointName, sc.status
     FROM student_courses sc
     JOIN courses c ON c.id = sc.course_id
     WHERE sc.student_id = ?`,
    [studentId]
  )

  courseRows.forEach((row) => {
    applyReviewPointStatus(
      statusMap,
      normalizeCheckpointName(row.pointName),
      resolveReviewPointStatus(row.status)
    )
  })

  try {
    const [orderRows] = await pool.query(
      `SELECT DISTINCT c.name AS pointName
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN courses c ON c.id = oi.course_id
       WHERE o.student_id = ?
         AND o.status = 'paid'`,
      [studentId]
    )

    orderRows.forEach((row) => {
      applyReviewPointStatus(statusMap, normalizeCheckpointName(row.pointName), 'pending')
    })
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error
    }
  }

  return REVIEW_POINT_LIST.map((item) => statusMap[item.pointName])
}

async function buildStudentAccessSummary(studentId) {
  const [[studentCourseRow]] = await pool.query(
    `SELECT
       COUNT(*) AS totalCount,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedCount,
       SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS activeCount
     FROM student_courses
     WHERE student_id = ?`,
    [studentId]
  )

  let paidOrderCourseCount = 0
  try {
    const [[paidOrderRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.student_id = ?
         AND o.status = 'paid'`,
      [studentId]
    )
    paidOrderCourseCount = Number(paidOrderRow && paidOrderRow.count) || 0
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error
    }
  }

  const [[diagnosisRow]] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM diagnosis_reports
     WHERE student_id = ?`,
    [studentId]
  )

  let pointRateCount = 0
  try {
    const [[pointRateRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM review_point_scores
       WHERE student_id = ?`,
      [studentId]
    )
    pointRateCount = Number(pointRateRow && pointRateRow.count) || 0
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error
    }
  }

  const activeCourseCount = Number(studentCourseRow && studentCourseRow.activeCount) || 0
  const completedCourseCount = Number(studentCourseRow && studentCourseRow.completedCount) || 0
  const enrolledCourseCount = Number(studentCourseRow && studentCourseRow.totalCount) || 0
  const diagnosisReportCount = Number(diagnosisRow && diagnosisRow.count) || 0

  // 查单独开通记录
  let specialDiagnose = false
  let specialDrill = false
  try {
    const [specialRows] = await pool.query(
      `SELECT type FROM student_special_courses WHERE student_id = ?`,
      [studentId]
    )
    for (const row of specialRows) {
      if (row.type === 'diagnose') specialDiagnose = true
      if (row.type === 'drill') specialDrill = true
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error
  }

  // 买了卡点课 → 一定附赠诊断课和刷题课
  const hasPurchasedCourse = enrolledCourseCount > 0 || paidOrderCourseCount > 0
  const hasDiagnoseCourse = hasPurchasedCourse || diagnosisReportCount > 0 || pointRateCount > 0 || specialDiagnose
  const hasDrillCourse = hasPurchasedCourse || specialDrill

  return {
    hasPurchasedCourse,
    hasDiagnoseCourse,
    hasDrillCourse,
    activeCourseCount,
    completedCourseCount,
    enrolledCourseCount,
    paidOrderCourseCount,
    diagnosisReportCount,
    pointRateCount,
  }
}

async function findOrCreateCourseForSync(pointName) {
  const safePointName = normalizeCheckpointName(pointName)
  if (!safePointName) return null

  const [[existingCourse]] = await pool.query(
    `SELECT id, name, subject
     FROM courses
     WHERE name = ?
     ORDER BY id ASC
     LIMIT 1`,
    [safePointName]
  )

  if (existingCourse) {
    return existingCourse
  }

  const [result] = await pool.query(
    `INSERT INTO courses (name, subject, description, price)
     VALUES (?, ?, ?, ?)`,
    [safePointName, '\u7533\u8bba', `${safePointName} \u5b66\u4e60\u8bfe\u7a0b`, 1080]
  )

  return {
    id: result.insertId,
    name: safePointName,
    subject: '\u7533\u8bba',
  }
}

function normalizeAssignedTheoryLessonForSync(lesson = {}) {
  return {
    title: String(lesson.title || '').trim(),
    videoId: String(lesson.videoId || '').trim(),
    preClassUrl: String(lesson.preClassUrl || '').trim(),
    analysisUrl: String(lesson.analysisUrl || '').trim(),
  }
}

function buildAssignedTheoryResourcesForSync(lesson, titlePrefix) {
  const resources = []

  if (lesson.preClassUrl) {
    resources.push({
      resource_type: 'pdf',
      phase: 'pre',
      title: `${titlePrefix} \u8bfe\u524d\u8bb2\u4e49`,
      url: lesson.preClassUrl,
      video_id: null,
    })
  }

  if (lesson.videoId) {
    resources.push({
      resource_type: 'video',
      phase: 'main',
      title: titlePrefix,
      url: null,
      video_id: lesson.videoId,
    })
  }

  if (lesson.analysisUrl) {
    resources.push({
      resource_type: 'pdf',
      phase: 'post',
      title: `${titlePrefix} \u8bfe\u540e\u8d44\u6599`,
      url: lesson.analysisUrl,
      video_id: null,
    })
  }

  return resources
}

async function upsertStudyDayForSync(studentId, courseId, dayNumber, status) {
  await pool.query(
    `INSERT INTO study_days (student_id, course_id, day_number, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status)`,
    [studentId, courseId, dayNumber, status]
  )

  const [[studyDay]] = await pool.query(
    'SELECT id FROM study_days WHERE student_id = ? AND course_id = ? AND day_number = ? LIMIT 1',
    [studentId, courseId, dayNumber]
  )

  return studyDay
}

async function upsertStudyTaskForSync(studyDayId, task) {
  await pool.query(
    `INSERT INTO study_tasks (study_day_id, name, description, type, duration_min, completed, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       type = VALUES(type),
       duration_min = VALUES(duration_min),
       completed = VALUES(completed)`,
    [studyDayId, task.name, task.description || null, task.type, task.duration, task.completed, task.sortOrder]
  )

  const [[studyTask]] = await pool.query(
    'SELECT id FROM study_tasks WHERE study_day_id = ? AND sort_order = ? LIMIT 1',
    [studyDayId, task.sortOrder]
  )

  return studyTask
}

async function replaceTaskResourcesForSync(taskId, resources = []) {
  await pool.query('DELETE FROM task_resources WHERE task_id = ?', [taskId])

  for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex += 1) {
    const resource = resources[resourceIndex]
    await pool.query(
      'INSERT INTO task_resources (task_id, resource_type, phase, title, url, video_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [taskId, resource.resource_type, resource.phase, resource.title, resource.url, resource.video_id, resourceIndex]
    )
  }
}

async function syncAssignedTheoryLessonsForStudent(studentId, course, assignmentMeta = {}) {
  const lessons = Array.isArray(assignmentMeta.theoryLessons)
    ? assignmentMeta.theoryLessons
      .map((lesson) => normalizeAssignedTheoryLessonForSync(lesson))
      .filter((lesson) => lesson.videoId || lesson.preClassUrl || lesson.analysisUrl)
    : []

  if (!course || !lessons.length) return

  await pool.query(
    `DELETE tr
     FROM task_resources tr
     JOIN study_tasks st ON tr.task_id = st.id
     JOIN study_days sd ON st.study_day_id = sd.id
     WHERE sd.student_id = ?
       AND sd.course_id = ?
       AND st.type IN ('video', 'review')`,
    [studentId, course.id]
  )

  for (let index = 0; index < lessons.length; index += 1) {
    const lesson = lessons[index]
    const dayNumber = index + 1
    const titlePrefix = lesson.title || `${course.name} \u5f55\u64ad\u8bfe${dayNumber}`
    const studyDay = await upsertStudyDayForSync(
      studentId,
      course.id,
      dayNumber,
      index === 0 ? 'in_progress' : 'pending'
    )
    const studyTask = await upsertStudyTaskForSync(studyDay.id, {
      name: `${titlePrefix} \u5f55\u64ad\u8bfe`,
      description: `${course.name} \u7b2c${dayNumber} \u8282\u5f55\u64ad\u8bfe`,
      type: 'video',
      duration: 45,
      completed: 0,
      sortOrder: 0,
    })

    await replaceTaskResourcesForSync(studyTask.id, buildAssignedTheoryResourcesForSync(lesson, titlePrefix))
  }
}

async function backfillStudentCoursesFromLearningPath(studentId) {
  const [assignmentRows] = await pool.query(
    `SELECT point_name, meta_json, updated_at AS assigned_at
     FROM student_learning_path_tasks
     WHERE student_id = ?
       AND stage_key = 'theory_config'
       AND task_id = 'assignment_config'
      ORDER BY assigned_at DESC, point_name ASC`,
    [studentId]
  )

  for (const row of assignmentRows) {
    const course = await findOrCreateCourseForSync(row.point_name)
    if (!course) continue

    await pool.query(
      `INSERT INTO student_courses (student_id, course_id, progress, status, created_at)
       VALUES (?, ?, 0, 'in_progress', COALESCE(?, NOW()))
       ON DUPLICATE KEY UPDATE
          student_id = VALUES(student_id)`,
      [studentId, course.id, row.assigned_at || null]
    )

    await syncAssignedTheoryLessonsForStudent(studentId, course, readMeta(row.meta_json))
    await syncStudentCourseProgress(studentId, row.point_name)
  }
}

function getStartOfDay(date = new Date()) {
  const current = new Date(date)
  current.setHours(0, 0, 0, 0)
  return current
}

function getStartOfWeek(date = new Date()) {
  const current = getStartOfDay(date)
  const day = current.getDay() || 7
  current.setDate(current.getDate() - day + 1)
  return current
}

function getStartOfMonth(date = new Date()) {
  const current = getStartOfDay(date)
  current.setDate(1)
  return current
}

function addDays(date, offset) {
  const current = new Date(date)
  current.setDate(current.getDate() + offset)
  return current
}

function addMonths(date, offset) {
  const current = new Date(date)
  current.setMonth(current.getMonth() + offset)
  return current
}

function formatDateKey(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatMonthKey(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  return `${year}-${month}`
}

function buildDayBuckets(now = new Date(), count = 7) {
  const start = getStartOfWeek(now)
  const labels = ['\u5468\u4e00', '\u5468\u4e8c', '\u5468\u4e09', '\u5468\u56db', '\u5468\u4e94', '\u5468\u516d', '\u5468\u65e5']

  return Array.from({ length: count }, (_, index) => {
    const date = addDays(start, index)
    return {
      key: `day${index + 1}`,
      bucketKey: formatDateKey(date),
      label: labels[index] || `\u7b2c${index + 1}\u5929`,
      sortOrder: index + 1,
      cycleType: 'day',
    }
  })
}

function buildWeekBuckets(now = new Date(), count = 4) {
  const currentWeek = getStartOfWeek(now)

  return Array.from({ length: count }, (_, index) => {
    const date = addDays(currentWeek, (index - (count - 1)) * 7)
    return {
      key: `week${index + 1}`,
      bucketKey: formatDateKey(date),
      label: `\u7b2c${index + 1}\u5468`,
      sortOrder: index + 1,
      cycleType: 'week',
    }
  })
}

function buildMonthBuckets(now = new Date(), count = 6) {
  const currentMonth = getStartOfMonth(now)

  return Array.from({ length: count }, (_, index) => {
    const date = addMonths(currentMonth, index - (count - 1))
    return {
      key: `month${index + 1}`,
      bucketKey: formatMonthKey(date),
      label: `${date.getMonth() + 1}\u6708`,
      sortOrder: index + 1,
      cycleType: 'month',
    }
  })
}

async function buildStudyTimesFromSessions(studentId, now = new Date()) {
  const dayBuckets = buildDayBuckets(now)
  const weekBuckets = buildWeekBuckets(now)
  const monthBuckets = buildMonthBuckets(now)
  const allBuckets = [...dayBuckets, ...weekBuckets, ...monthBuckets]

  let sessionRows = []
  let manualRows = []
  try {
    const [rows] = await pool.query(
      `SELECT started_at, ended_at, duration_sec
       FROM study_sessions
       WHERE student_id = ?
         AND started_at IS NOT NULL
         AND status IN ('started', 'completed')`,
      [studentId]
    )
    sessionRows = rows
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error
    }
  }

  try {
    const [rows] = await pool.query(
      `SELECT
         period_key AS \`key\`,
         period_label AS label,
         hours,
         sort_order AS sortOrder,
         cycle_type AS cycleType
       FROM study_time_stats
       WHERE student_id = ?
         AND id IN (
           SELECT MAX(id)
           FROM study_time_stats
           WHERE student_id = ?
           GROUP BY period_key
         )
       ORDER BY sort_order ASC, id ASC`,
      [studentId, studentId]
    )
    manualRows = rows
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error
    }
  }

  const sessionTotals = {
    day: {},
    week: {},
    month: {},
  }

  sessionRows.forEach((row) => {
    const startedAt = row.started_at ? new Date(row.started_at) : null
    if (!startedAt || Number.isNaN(startedAt.getTime())) return

    const rawDuration = Number(row.duration_sec || 0)
    const endedAt = row.ended_at ? new Date(row.ended_at) : null
    const durationSec = rawDuration > 0
      ? rawDuration
      : endedAt && !Number.isNaN(endedAt.getTime())
        ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
        : 0
    const hours = Math.round((durationSec / 3600) * 100) / 100
    if (hours <= 0) return

    const dayKey = formatDateKey(startedAt)
    const weekKey = formatDateKey(getStartOfWeek(startedAt))
    const monthKey = formatMonthKey(startedAt)
    sessionTotals.day[dayKey] = (sessionTotals.day[dayKey] || 0) + hours
    sessionTotals.week[weekKey] = (sessionTotals.week[weekKey] || 0) + hours
    sessionTotals.month[monthKey] = (sessionTotals.month[monthKey] || 0) + hours
  })

  const manualRowsByKey = new Map(
    manualRows
      .map((row) => {
        const key = String(row.key || '').trim()
        const cycleType = ['day', 'week', 'month'].includes(row.cycleType) ? row.cycleType : 'week'
        const sortOrder = Number(row.sortOrder || 0)
        const hours = Number(row.hours)
        if (!key || !Number.isFinite(hours)) {
          return null
        }

        return [
          key,
          {
            key,
            label: String(row.label || '').trim() || key,
            hours: Math.max(0, Math.round(hours * 100) / 100),
            sortOrder,
            cycleType,
          },
        ]
      })
      .filter(Boolean)
  )

  const bucketKeySet = new Set(allBuckets.map((bucket) => bucket.key))
  const mergedRows = allBuckets.map((bucket) => {
    const manualRow = manualRowsByKey.get(bucket.key)
    const sessionHours = sessionTotals[bucket.cycleType][bucket.bucketKey] || 0
    const manualHours = manualRow ? manualRow.hours : 0

    return {
      key: bucket.key,
      label: manualRow && manualRow.label ? manualRow.label : bucket.label,
      hours: Math.round((sessionHours + manualHours) * 100) / 100,
      sortOrder: bucket.sortOrder,
      cycleType: bucket.cycleType,
    }
  })

  const extraManualRows = [...manualRowsByKey.values()]
    .filter((row) => !bucketKeySet.has(row.key))
    .sort((left, right) => {
      if (left.cycleType !== right.cycleType) {
        return `${left.cycleType}`.localeCompare(`${right.cycleType}`)
      }
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0)
    })

  return [...mergedRows, ...extraManualRows]
}

function resolveSessionDurationSec(payload = {}) {
  const directDuration = Number(payload.durationSec)
  if (Number.isFinite(directDuration) && directDuration >= 0) {
    return Math.round(directDuration)
  }

  const startedAt = payload.startedAt ? new Date(payload.startedAt) : null
  const endedAt = payload.endedAt ? new Date(payload.endedAt) : null
  if (startedAt && endedAt && !Number.isNaN(startedAt.getTime()) && !Number.isNaN(endedAt.getTime())) {
    return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
  }

  return 0
}

async function resolvePrescribedDurationSec(studentId, studyTaskId, durationMin) {
  const safeDurationMin = Number(durationMin)

  if (studyTaskId) {
    const [[taskRow]] = await pool.query(
      `SELECT st.duration_min AS durationMin
       FROM study_tasks st
       JOIN study_days sd ON sd.id = st.study_day_id
       WHERE st.id = ?
         AND sd.student_id = ?
       LIMIT 1`,
      [studyTaskId, studentId]
    )

    const taskDurationMin = Number(taskRow && taskRow.durationMin)
    if (Number.isFinite(taskDurationMin) && taskDurationMin > 0) {
      return Math.round(taskDurationMin * 60)
    }
  }

  if (Number.isFinite(safeDurationMin) && safeDurationMin > 0) {
    return Math.round(safeDurationMin * 60)
  }

  return 0
}

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function toIsoString(value) {
  const date = toValidDate(value)
  return date ? date.toISOString() : ''
}

function getLocalDayKey(date) {
  return formatDateKey(getStartOfDay(date))
}

function getLateScore(date) {
  const hours = date.getHours() + (date.getMinutes() / 60)
  return hours < 5 ? hours + 24 : hours
}

router.get('/point-learning-summary', async (req, res) => {
  const studentId = req.user.id
  const pointName = String(req.query.pointName || '').trim()

  if (!pointName) {
    return res.status(400).json({ message: '???????' })
  }

  try {
    const [[pointRow]] = await pool.query(
      `SELECT drp.course_id
       FROM diagnosis_report_points drp
       JOIN diagnosis_reports dr ON dr.id = drp.report_id
       WHERE dr.student_id = ?
         AND drp.point_name = ?
       ORDER BY COALESCE(dr.diagnosis_date, dr.created_at) DESC, dr.id DESC, drp.sort_order ASC
       LIMIT 1`,
      [studentId, pointName]
    )

    const courseId = pointRow && pointRow.course_id ? Number(pointRow.course_id) : null
    const querySql = courseId
      ? `SELECT started_at, ended_at, duration_sec
         FROM study_sessions
         WHERE student_id = ?
           AND (course_id = ? OR point_name = ?)
           AND started_at IS NOT NULL
           AND status IN ('started', 'completed')`
      : `SELECT started_at, ended_at, duration_sec
         FROM study_sessions
         WHERE student_id = ?
           AND point_name = ?
           AND started_at IS NOT NULL
           AND status IN ('started', 'completed')`
    const queryParams = courseId ? [studentId, courseId, pointName] : [studentId, pointName]
    const [rows] = await pool.query(querySql, queryParams)

    let totalDurationSec = 0
    let earliestSession = null
    let latestSession = null
    const dayTotals = new Map()

    rows.forEach((row) => {
      const startedAt = toValidDate(row.started_at)
      if (!startedAt) return

      const endedAt = toValidDate(row.ended_at)
      const rawDuration = Number(row.duration_sec || 0)
      const durationSec = rawDuration > 0
        ? rawDuration
        : endedAt
          ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
          : 0

      if (durationSec <= 0) return

      totalDurationSec += durationSec

      const dayKey = getLocalDayKey(startedAt)
      const currentDay = dayTotals.get(dayKey) || { date: dayKey, durationSec: 0 }
      currentDay.durationSec += durationSec
      dayTotals.set(dayKey, currentDay)

      const startClock = startedAt.getHours() * 60 + startedAt.getMinutes()
      if (!earliestSession || startClock < earliestSession.clock) {
        earliestSession = {
          date: dayKey,
          startedAt: toIsoString(startedAt),
          clock: startClock,
        }
      }

      const sessionEnd = endedAt || new Date(startedAt.getTime() + durationSec * 1000)
      const lateScore = getLateScore(sessionEnd)
      if (!latestSession || lateScore > latestSession.score) {
        latestSession = {
          date: dayKey,
          endedAt: toIsoString(sessionEnd),
          score: lateScore,
        }
      }
    })

    const longestDay = [...dayTotals.values()]
      .sort((left, right) => {
        if (right.durationSec !== left.durationSec) {
          return right.durationSec - left.durationSec
        }
        return `${right.date}`.localeCompare(`${left.date}`)
      })[0] || null

    // 最近一次视频回放时间
    const videoSessionSql = courseId
      ? `SELECT ended_at FROM study_sessions
         WHERE student_id = ? AND (course_id = ? OR point_name = ?)
           AND session_type = 'video' AND ended_at IS NOT NULL
         ORDER BY ended_at DESC LIMIT 1`
      : `SELECT ended_at FROM study_sessions
         WHERE student_id = ? AND point_name = ?
           AND session_type = 'video' AND ended_at IS NOT NULL
         ORDER BY ended_at DESC LIMIT 1`
    const videoParams = courseId ? [studentId, courseId, pointName] : [studentId, pointName]
    const [[videoRow]] = await pool.query(videoSessionSql, videoParams)

    // 最近一次作业提交时间
    const [[submissionRow]] = await pool.query(
      `SELECT created_at FROM pdf_submissions
       WHERE student_id = ? AND point_name = ?
       ORDER BY created_at DESC LIMIT 1`,
      [studentId, pointName]
    )

    res.json({
      pointName,
      courseId,
      totalDurationSec,
      longestDay: longestDay
        ? {
            date: longestDay.date,
            durationSec: longestDay.durationSec,
          }
        : null,
      earliestSession: earliestSession
        ? {
            date: earliestSession.date,
            startedAt: earliestSession.startedAt,
          }
        : null,
      latestSession: latestSession
        ? {
            date: latestSession.date,
            endedAt: latestSession.endedAt,
          }
        : null,
      lastPlaybackAt: videoRow ? toIsoString(toValidDate(videoRow.ended_at)) : null,
      lastHomeworkSubmitAt: submissionRow ? toIsoString(toValidDate(submissionRow.created_at)) : null,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/learning-path', async (req, res) => {
  const studentId = req.user.id
  const pointName = String(req.query.pointName || req.body?.pointName || '').trim()

  if (!pointName) {
    return res.status(400).json({ message: '???????' })
  }

  try {
    res.json(await buildStudentLearningPath(studentId, pointName))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.patch('/learning-path/tasks/:taskId', async (req, res) => {
  const studentId = req.user.id
  const taskId = String(req.params.taskId || '').trim()
  const pointName = String(req.body.pointName || '').trim()
  const stageKey = String(req.body.stageKey || '').trim()

  if (!taskId) {
    return res.status(400).json({ message: '?????ID' })
  }

  if (!pointName) {
    return res.status(400).json({ message: '???????' })
  }

  if (!stageKey) {
    return res.status(400).json({ message: '???????' })
  }

  const status = String(req.body.status || 'done').trim() || 'done'
  const metaPatch = {
    selectedLabel: req.body.selectedLabel,
    uploadCount: req.body.uploadCount,
    uploadedAt: req.body.uploadedAt,
    processingStartedAt: req.body.processingStartedAt,
    processingDone: req.body.processingDone,
    timerSeconds: req.body.timerSeconds,
    timerFinishedAt: req.body.timerFinishedAt,
    appointment: req.body.appointment,
    rating: req.body.rating,
    result: req.body.result,
    resource: req.body.resource,
    uploads: req.body.uploads,
  }

  try {
    const safePointName = normalizeCheckpointName(pointName)
    const learningPathRows = await loadLearningPathRows(studentId, safePointName)
    const taskDefinition = findTaskDefinition(stageKey, taskId, learningPathRows)

    // 即使找不到任务定义也允许写入，确保学生行为被记录
    // 只有能找到定义时才做顺序校验
    if (taskDefinition) {
      const validationError = await validateStudentLearningPathPatch({
        studentId,
        pointName: safePointName,
        stageKey,
        taskId,
        status,
        learningPathRows,
      })

      if (validationError) {
        return res.status(400).json({ message: validationError })
      }
    }

    const payload = await saveLearningPathTask({
      studentId,
      pointName,
      stageKey,
      taskId,
      status,
      metaPatch,
      actorRole: 'student',
      actorId: studentId,
    })

    if (taskDefinition && metaPatch.rating && typeof metaPatch.rating === 'object') {
      const taskResource = taskDefinition.resource && typeof taskDefinition.resource === 'object'
        ? taskDefinition.resource
        : {}
      const ratingContext = getTheoryRatingContext(learningPathRows, taskId)
      const ratingTitle = String(ratingContext.lessonTitle || taskResource.title || taskDefinition.title || '').trim()

      await upsertRatingFeedback({
        studentId,
        pointName: safePointName,
        title: ratingTitle,
        score: metaPatch.rating.score,
        ratedAt: metaPatch.rating.ratedAt,
        taskId,
        stageKey,
        ...ratingContext,
      })
    }

    res.json({ ok: true, ...payload })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/submissions', async (req, res) => {
  const studentId = req.user.id
  const pointName = normalizeCheckpointName(req.query.pointName || '')
  const stageKey = String(req.query.stageKey || '').trim()
  const taskId = String(req.query.taskId || '').trim()
  const feedbackTaskId = String(req.query.feedbackTaskId || '').trim()
  const graded = String(req.query.graded || '').trim()

  const where = ['student_id = ?']
  const params = [studentId]

  if (pointName) {
    where.push('point_name = ?')
    params.push(pointName)
  }

  if (stageKey) {
    where.push('stage_key = ?')
    params.push(stageKey)
  }

  if (taskId) {
    where.push('(task_id = ? OR feedback_task_id = ?)')
    params.push(taskId, taskId)
  }

  if (feedbackTaskId) {
    where.push('feedback_task_id = ?')
    params.push(feedbackTaskId)
  }

  if (graded === 'true' || graded === '1') {
    where.push('graded = 1')
  } else if (graded === 'false' || graded === '0') {
    where.push('graded = 0')
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, student_id, student_name, review_type, checkpoint, deadline, priority,
              submitted_normal, file_name, point_name, stage_key, task_id, feedback_task_id,
              reviewed_file_name, reviewed_stored_file,
              graded, score, feedback, graded_at, created_at
       FROM pdf_submissions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC`,
      params
    )

    res.json(rows.map(formatSubmission))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/submissions/:submissionId', async (req, res) => {
  const studentId = req.user.id
  const submissionId = String(req.params.submissionId || '').trim()

  if (!submissionId) {
    return res.status(400).json({ message: '???????ID' })
  }

  try {
    const [[row]] = await pool.query(
      `SELECT id, student_id, student_name, review_type, checkpoint, deadline, priority,
              submitted_normal, file_name, point_name, stage_key, task_id, feedback_task_id,
              reviewed_file_name, reviewed_stored_file,
              graded, score, feedback, graded_at, created_at
       FROM pdf_submissions
       WHERE id = ? AND student_id = ?
       LIMIT 1`,
      [submissionId, studentId]
    )

    if (!row) {
      return res.status(404).json({ message: '???????' })
    }

    res.json(formatSubmission(row))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/submissions/:submissionId/review-file', async (req, res) => {
  const studentId = req.user.id
  const submissionId = String(req.params.submissionId || '').trim()

  if (!submissionId) {
    return res.status(400).json({ message: '???????ID' })
  }

  try {
    const [[row]] = await pool.query(
      `SELECT reviewed_file_name, reviewed_stored_file
       FROM pdf_submissions
       WHERE id = ? AND student_id = ?
       LIMIT 1`,
      [submissionId, studentId]
    )

    if (!row) {
      return res.status(404).json({ message: '???????' })
    }

    if (!row.reviewed_stored_file) {
      return res.status(404).json({ message: '闂傚倸鍊搁崐鎼佸磹妞嬪海鐭嗗〒姘ｅ亾濠碘€崇埣楠炴牗鎷呯喊妯轰壕闁稿瞼鍋為弲婊堟煕閹炬鎳愰崝璺衡攽閻愯埖褰х紓宥佸亾濠电偛鎷戠徊璺ㄥ垝婵犳艾绫嶉柛顐ゅ枔閸樻捇鎮峰鍕煉鐎规洘绮撻幃銏ゆ偂鎼淬倖鎲伴梻浣芥硶閸犳挻鎱ㄩ幘顔惧祦闁靛繆鈧尙绠氶梺闈涚墕閸婂憡绂嶆ィ鍐┾拺闂侇偆鍋涢懟顖涙櫠娴煎瓨鐓欓柧蹇ｅ亝瀹曞矂鏌℃担绋挎殻濠殿喒鍋撻梺闈涚墕鐎涒晠寮查敐澶嬧拺缂備焦蓱椤ュ棝鏌曢崱蹇撲壕闂備礁鎼鍡涙偋濡ゅ啯宕叉繝闈涱儐閸嬨劑姊婚崼鐔峰瀬闁跨喓濮甸悡鐘绘煕閹邦垰鐨洪柛鈺嬬秮閺岀喖顢欓悾灞惧櫗缂備胶绮换鍫濈暦閸洖惟鐟滃秹鐛鍛斀闁绘劘鍩栬ぐ褏绱掗煫顓犵煓鐎规洘婢橀～婵嬵敆婢跺苯濮洪梻浣筋潐婢瑰棙鏅跺Δ鍛亗?PDF' })
    }

    const filePath = path.join(UPLOADS_DIR, row.reviewed_stored_file)
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '?????PDF??' })
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.reviewed_file_name || 'reviewed.pdf')}"`)
    fs.createReadStream(filePath).pipe(res)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})


function buildDefaultAvatarPresets() {
  return Array.from({ length: 10 }, (_, index) => {
    const id = `avatar-${String(index + 1).padStart(2, '0')}`
    return {
      id,
      label: `头像 ${index + 1}`,
      url: `/assets/avatars/${id}.png`,
    }
  })
}

router.get('/avatar-presets', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT avatar_key AS id, label, avatar_url AS url
       FROM student_avatar_presets
       ORDER BY sort_order ASC, id ASC`
    )

    res.json(rows.length ? rows : buildDefaultAvatarPresets())
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') {
      return res.json(buildDefaultAvatarPresets())
    }

    res.status(500).json({ message: err.message })
  }
})

router.patch('/profile/avatar', async (req, res) => {
  const studentId = req.user.id
  const avatarUrl = String(req.body.avatarUrl || '').trim()

  if (!avatarUrl) {
    return res.status(400).json({ message: '缺少头像地址' })
  }

  try {
    const [[preset]] = await pool.query(
      'SELECT avatar_url FROM student_avatar_presets WHERE avatar_url = ? LIMIT 1',
      [avatarUrl]
    )

    if (!preset) {
      return res.status(400).json({ message: '头像不在可选列表中' })
    }

    await pool.query(
      `INSERT INTO student_profiles (student_id, avatar_url)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE avatar_url = VALUES(avatar_url)`,
      [studentId, avatarUrl]
    )

    res.json({ ok: true, avatarUrl })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/profile', async (req, res) => {
  const studentId = req.user.id

  try {
    await backfillStudentCoursesFromLearningPath(studentId)
    await syncAllStudentCourseProgress(studentId)

    const [[profileInfo]] = await pool.query(
      `SELECT s.id, s.name, s.phone, s.status,
              sp.gender, sp.grade, sp.hometown,
              sp.exam_status AS examStatus,
              DATE_FORMAT(sp.exam_date, '%Y-%m-%d') AS examTime,
              sp.education, sp.major,
              sp.avatar_url AS avatarUrl
       FROM students s
       LEFT JOIN student_profiles sp ON sp.student_id = s.id
       WHERE s.id = ?
       LIMIT 1`,
      [studentId]
    )

    const [inProgress] = await pool.query(
      `SELECT sc.id, sc.course_id AS course_id, c.name, c.subject, sc.progress, sc.status
       FROM student_courses sc
       JOIN courses c ON sc.course_id = c.id
       WHERE sc.student_id = ? AND sc.status != 'completed'
       ORDER BY sc.created_at DESC, sc.id DESC`,
      [studentId]
    )

    const [completed] = await pool.query(
      `SELECT sc.id, sc.course_id AS course_id, c.name, c.subject, sc.progress, sc.status
       FROM student_courses sc
       JOIN courses c ON sc.course_id = c.id
       WHERE sc.student_id = ? AND sc.status = 'completed'
       ORDER BY sc.created_at ASC, sc.id ASC`,
      [studentId]
    )

    res.json({
      inProgress,
      completed,
      profileInfo: profileInfo || null,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/access-summary', async (req, res) => {
  try {
    await backfillStudentCoursesFromLearningPath(req.user.id)
    await syncAllStudentCourseProgress(req.user.id)
    res.json(await buildStudentAccessSummary(req.user.id))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/study/:courseId', async (req, res) => {
  const { courseId } = req.params
  const studentId = req.user.id

  try {
    const [[course]] = await pool.query(
      `SELECT sc.progress, sc.status, c.name
       FROM student_courses sc
       JOIN courses c ON sc.course_id = c.id
       WHERE sc.student_id = ? AND sc.course_id = ?`,
      [studentId, courseId]
    )

    if (!course) {
      return res.status(404).json({ message: '???????' })
    }

    const [days] = await pool.query(
      'SELECT * FROM study_days WHERE student_id = ? AND course_id = ? ORDER BY day_number',
      [studentId, courseId]
    )

    for (const day of days) {
      const [tasks] = await pool.query(
        'SELECT * FROM study_tasks WHERE study_day_id = ? ORDER BY sort_order',
        [day.id]
      )
      for (const task of tasks) {
        const [resources] = await pool.query(
          `SELECT id, resource_type, phase, title, url, video_id, sort_order
           FROM task_resources
           WHERE task_id = ?
           ORDER BY sort_order, id`,
          [task.id]
        )
        task.resources = resources
      }
      day.tasks = tasks
    }

    res.json({ course, days })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/polyv/play-auth', async (req, res) => {
  const videoId = String(req.query.videoId || req.query.vid || '').trim()

  if (!videoId) {
    return res.status(400).json({ message: '缂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紓浣哄Ь椤濡甸崟顖氱疀闁割偅娲橀宥夋⒑缁嬪潡顎楃紒澶屾暬婵＄敻宕熼姘敤闂侀潧臎閸涱垰甯掗梻鍌欑閹芥粍鎱ㄩ弶鎳虫稑鈹戠€ｎ亣鎽曞┑鐐村灟閸ㄥ綊鎮炲ú顏呯厱闁规澘鑻幊鎰不閹烘鈷?VID' })
  }

  try {
    const authData = await getPolyvPlayAuth(videoId, req)
    if (!authData || !authData.playsafe) {
      return res.status(503).json({ message: '?????????' })
    }

    res.json({
      code: 0,
      message: '??',
      data: authData,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put('/study/tasks/:taskId/complete', async (req, res) => {
  try {
    await pool.query('UPDATE study_tasks SET completed = 1 WHERE id = ?', [req.params.taskId])
    res.json({ message: '?????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/review', async (req, res) => {
  const studentId = req.user.id

  try {
    const [reviews] = await pool.query(
      'SELECT * FROM reviews WHERE student_id = ? ORDER BY created_at DESC LIMIT 1',
      [studentId]
    )
    const review = reviews[0]

    if (!review) {
      return res.json(null)
    }

    const [items] = await pool.query(
      'SELECT * FROM review_items WHERE review_id = ? ORDER BY type, sort_order',
      [review.id]
    )

    res.json({ ...review, items })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/review-overview', async (req, res) => {
  const studentId = req.user.id

  try {
    const [[firstDiagnosis]] = await pool.query(
      `SELECT id, target_exam AS targetExam, diagnosis_score, target_score, diagnosis_date, created_at
       FROM diagnosis_reports
       WHERE student_id = ?
       ORDER BY COALESCE(diagnosis_date, created_at) ASC, id ASC
       LIMIT 1`,
      [studentId]
    )

    const [[latestDiagnosis]] = await pool.query(
      `SELECT id, target_exam AS targetExam, diagnosis_score, target_score, diagnosis_date, created_at
       FROM diagnosis_reports
       WHERE student_id = ?
       ORDER BY COALESCE(diagnosis_date, created_at) DESC, id DESC
       LIMIT 1`,
      [studentId]
    )

    let pointRates = []
    try {
      const [rows] = await pool.query(
        `SELECT
           point_name AS pointName,
           current_rate AS currentRate,
           target_rate AS targetRate,
           sort_order AS sortOrder,
           source_type AS sourceType,
           created_at AS updatedAt
         FROM review_point_scores
         WHERE student_id = ?
           AND id IN (
             SELECT MAX(id)
             FROM review_point_scores
             WHERE student_id = ?
             GROUP BY point_name
           )
         ORDER BY sort_order ASC, id ASC`,
        [studentId, studentId]
      )
      pointRates = rows
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error
      }
    }

    const studyTimes = await buildStudyTimesFromSessions(studentId)
    const pointStatuses = await getReviewPointStatuses(studentId)

    res.json({
      targetExam: latestDiagnosis && latestDiagnosis.targetExam
        ? latestDiagnosis.targetExam
        : firstDiagnosis && firstDiagnosis.targetExam
          ? firstDiagnosis.targetExam
          : '',
      progress: {
        entryScore: firstDiagnosis ? firstDiagnosis.diagnosis_score : null,
        currentScore: latestDiagnosis && firstDiagnosis && latestDiagnosis.id !== firstDiagnosis.id
          ? latestDiagnosis.diagnosis_score
          : null,
        targetScore: latestDiagnosis
          ? latestDiagnosis.target_score
          : firstDiagnosis
            ? firstDiagnosis.target_score
            : null,
      },
      pointRates,
      pointStatuses,
      studyTimes,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/study-sessions', async (req, res) => {
  const studentId = req.user.id
  const {
    courseId = null,
    studyTaskId = null,
    pointName = '',
    sessionType = 'other',
    status = 'completed',
    startedAt,
    endedAt,
    durationSec,
    durationMin = null,
    prescribed = false,
  } = req.body || {}

  const allowedSessionTypes = new Set(['lesson', 'video', 'practice', 'review', 'exam', 'other'])
  const allowedStatuses = new Set(['started', 'completed', 'aborted'])
  const safeSessionType = allowedSessionTypes.has(sessionType) ? sessionType : 'other'
  const safeStatus = allowedStatuses.has(status) ? status : 'completed'
  const safeStartedAt = startedAt ? new Date(startedAt) : new Date()
  const safeEndedAt = endedAt ? new Date(endedAt) : new Date()

  if (Number.isNaN(safeStartedAt.getTime())) {
    return res.status(400).json({ message: '????????' })
  }

  try {
    const resolvedDurationSec = prescribed
      ? await resolvePrescribedDurationSec(studentId, studyTaskId, durationMin)
      : resolveSessionDurationSec({
          durationSec,
          startedAt: safeStartedAt,
          endedAt: safeEndedAt,
        })

    if (prescribed && resolvedDurationSec <= 0) {
      return res.status(400).json({ message: '???????????' })
    }

    const [result] = await pool.query(
      `INSERT INTO study_sessions (student_id, course_id, study_task_id, point_name, session_type, status, started_at, ended_at, duration_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        studentId,
        courseId || null,
        studyTaskId || null,
        String(pointName || '').trim() || null,
        safeSessionType,
        safeStatus,
        safeStartedAt,
        safeStatus === 'started' ? null : (Number.isNaN(safeEndedAt.getTime()) ? null : safeEndedAt),
        resolvedDurationSec,
      ]
    )

    res.json({
      id: result.insertId,
      message: '???????',
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

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

router.get('/courses', async (_req, res) => {
  try {
    const [courses] = await pool.query('SELECT * FROM courses WHERE is_active = 1')
    res.json(courses)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

function notificationUrlByType(type, relatedType, relatedId) {
  if (type === 'class') return relatedId ? `/pages/lesson-live/lesson-live?eventId=${relatedId}` : '/pages/lesson-live/lesson-live'
  if (type === 'exam') return '/pages/lesson-exam/lesson-exam'
  if (type === 'homework') return '/pages/lesson-correct/lesson-correct'
  if (type === 'review') return '/pages/results/results'
  if (type === 'leave') return '/pages/leave/leave'
  if (relatedType === 'diagnose_detail') return '/pages/diagnose-detail/diagnose-detail?source=notification'
  if (relatedType === 'diagnose_coupon') return '/pages/purchase/purchase?mode=diagnose&coupon=1&source=notification'
  if (relatedType === 'submission' && relatedId) return '/pages/results/results'
  return '/pages/notifications/notifications'
}

function formatNotification(row) {
  return {
    id: String(row.id),
    type: row.type,
    title: row.title,
    content: row.content || '',
    relatedType: row.related_type || '',
    relatedId: row.related_id || '',
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    isRead: Boolean(row.is_read),
    url: notificationUrlByType(row.type, row.related_type, row.related_id),
  }
}

router.get('/notifications', async (req, res) => {
  const studentId = req.user.id

  try {
    const [rows] = await pool.query(
      `SELECT id, type, title, content, related_type, related_id, scheduled_at, is_read, read_at, created_at
       FROM notifications
       WHERE student_id = ?
       ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC
       LIMIT 50`,
      [studentId]
    )

    res.json(rows.map(formatNotification))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.patch('/notifications/read-all', async (req, res) => {
  const studentId = req.user.id

  try {
    await pool.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE student_id = ? AND is_read = 0',
      [studentId]
    )
    res.json({ message: '????????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.patch('/notifications/:id/read', async (req, res) => {
  const studentId = req.user.id

  try {
    await pool.query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND student_id = ?',
      [req.params.id, studentId]
    )
    res.json({ message: '??????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/feedbacks', async (req, res) => {
  const studentId = req.user.id
  const source = sanitizeFeedbackSource(req.body.source)
  const title = String(req.body.title || '').trim().slice(0, 120)
  const pointName = normalizeCheckpointName(String(req.body.pointName || '').trim()).slice(0, 100)
  const content = String(req.body.content || '').trim().slice(0, 5000)
  const attachmentsInput = Array.isArray(req.body.attachments) ? req.body.attachments : []
  const rawCourseId = Number(req.body.courseId)
  const courseId = Number.isFinite(rawCourseId) && rawCourseId > 0 ? rawCourseId : null
  const rawMeta = req.body.meta && typeof req.body.meta === 'object' && !Array.isArray(req.body.meta)
    ? req.body.meta
    : {}
  const meta = normalizeFeedbackMeta(rawMeta)

  if (!source) {
    return res.status(400).json({ message: '???????' })
  }

  if (!content && attachmentsInput.length === 0) {
    return res.status(400).json({ message: '????????????' })
  }

  if (attachmentsInput.length > 6) {
    return res.status(400).json({ message: '??????6?' })
  }

  try {
    await ensureStudentFeedbackTable()

    const attachments = await persistFeedbackAttachments(attachmentsInput, UPLOADS_DIR)
    const [result] = await pool.query(
      `INSERT INTO student_feedback_messages (
         student_id, source, title, point_name, course_id, content,
         attachments_json, meta_json, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        studentId,
        source,
        title || null,
        pointName || null,
        courseId,
        content || null,
        JSON.stringify(attachments),
        JSON.stringify(meta),
      ],
    )

    res.json({
      id: result.insertId,
      status: 'pending',
      message: '?????',
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/mailbox', async (req, res) => {
  const studentId = req.user.id
  const category = String(req.body.category || '????').trim().slice(0, 50) || '????'
  const content = String(req.body.content || '').trim()
  const anonymous = req.body.anonymous === undefined ? true : Boolean(req.body.anonymous)

  if (!content) {
    return res.status(400).json({ message: '???????' })
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO student_mailbox_messages (student_id, category, content, anonymous, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [studentId, category, content, anonymous ? 1 : 0]
    )

    await pool.query(
      `INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at)
       VALUES (?, 'system', ?, ?, 'mailbox', ?, NOW())`,
      [
        studentId,
        '???????',
        '???????????????????',
        String(result.insertId),
      ]
    )

    res.json({
      id: result.insertId,
      status: 'pending',
      message: '?????',
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/leave', async (req, res) => {
  const studentId = req.user.id
  const { type, courseId, pointName, stepName, days, reason } = req.body

  try {
    if (courseId) {
      const [[leaveCount]] = await pool.query(
        `SELECT COUNT(*) as count FROM leave_requests
         WHERE student_id = ? AND course_id = ? AND status != 'rejected'`,
        [studentId, courseId]
      )

      if (leaveCount.count >= 2) {
        return res.status(400).json({ message: '?????????2???' })
      }
    }

    const [result] = await pool.query(
      `INSERT INTO leave_requests (student_id, type, course_id, point_name, step_name, days, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [studentId, type || 'single', courseId || null, pointName || '', stepName || '', days || 1, reason || '']
    )

    await pool.query(
      `INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at)
       VALUES (?, 'leave', ?, ?, 'leave_request', ?, NOW())`,
      [
        studentId,
        '???????',
        '?????????????????',
        String(result.insertId),
      ]
    )

    res.json({ id: result.insertId, status: 'pending', message: '???????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

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

router.patch('/leave/:id/approve', async (req, res) => {
  try {
    await pool.query(
      "UPDATE leave_requests SET status = 'approved', approved_at = NOW() WHERE id = ?",
      [req.params.id]
    )
    res.json({ message: '?????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.delete('/leave/:id', async (req, res) => {
  const studentId = req.user.id

  try {
    const [result] = await pool.query(
      "DELETE FROM leave_requests WHERE id = ? AND student_id = ? AND status = 'pending'",
      [req.params.id, studentId]
    )

    if (result.affectedRows === 0) {
      return res.status(400).json({ message: '????????????' })
    }

    res.json({ message: '???????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET /api/student/materials/handouts - 获取讲义列表
router.get('/materials/handouts', async (req, res) => {
  const studentId = req.user.id
  const eventId = req.query.eventId ? Number(req.query.eventId) : null

  try {
    const where = ['lm.student_id = ?', "lm.material_type = 'handout'"]
    const params = [studentId]

    if (eventId) {
      where.push('lm.calendar_event_id = ?')
      params.push(eventId)
    }

    const [rows] = await pool.query(
      `SELECT lm.id, lm.title, lm.file_name, lm.created_at,
              ce.id AS event_id, ce.title AS event_title, ce.date AS event_date
       FROM lesson_materials lm
       LEFT JOIN calendar_events ce ON ce.id = lm.calendar_event_id
       WHERE ${where.join(' AND ')}
       ORDER BY lm.created_at DESC`,
      params
    )

    res.json(rows.map((row) => ({
      id: row.id,
      title: row.title || row.file_name || '讲义',
      fileName: row.file_name || '',
      createdAt: row.created_at,
      eventId: row.event_id,
      eventTitle: row.event_title || '',
      eventDate: row.event_date || '',
    })))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET /api/student/materials/handouts/:id/file - 下载讲义文件
router.get('/materials/handouts/:id/file', async (req, res) => {
  const studentId = req.user.id
  const handoutId = Number(req.params.id)

  if (!handoutId) {
    return res.status(400).json({ message: '缺少讲义ID' })
  }

  try {
    const [[row]] = await pool.query(
      `SELECT lm.file_name, lm.stored_file
       FROM lesson_materials lm
       WHERE lm.id = ? AND lm.student_id = ? AND lm.material_type = 'handout'
       LIMIT 1`,
      [handoutId, studentId]
    )

    if (!row) {
      return res.status(404).json({ message: '讲义不存在' })
    }

    if (!row.stored_file) {
      return res.status(404).json({ message: '讲义文件不存在' })
    }

    const filePath = path.join(UPLOADS_DIR, row.stored_file)
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '讲义文件已丢失' })
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name || 'handout.pdf')}"`)
    fs.createReadStream(filePath).pipe(res)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// GET /api/student/lesson-live/:eventId  - 获取直播课信息（含腾讯会议链接）
router.get('/lesson-live/:eventId', auth('student'), async (req, res) => {
  const studentId = req.user.id
  try {
    const [[row]] = await pool.query(
      `SELECT ce.id, ce.title, ce.date, ce.start_time, ce.end_time, ce.link AS live_url,
              t.name AS teacher_name
       FROM calendar_events ce
       JOIN teacher_students ts ON ts.teacher_id = ce.teacher_id AND ts.student_id = ?
       JOIN teachers t ON t.id = ce.teacher_id
       WHERE ce.id = ? AND (ce.student_id = ? OR ce.student_id IS NULL)`,
      [studentId, req.params.eventId, studentId]
    )
    if (!row) return res.status(404).json({ error: '课程不存在' })
    res.json(row)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
