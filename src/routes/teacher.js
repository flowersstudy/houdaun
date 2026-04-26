const router = require('express').Router()
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const { v4: uuidv4 } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const {
  buildLearningPathPayload,
  findTaskDefinition,
  summarizeLearningPathProgress,
} = require('../lib/learningPath')
const {
  ensureStudentFeedbackTable,
  getFeedbackSourceLabel,
  mapStudentFeedbackRow,
} = require('../lib/studentFeedback')
const { normalizeCheckpointName, ALL_CHECKPOINTS } = require('../lib/checkpoint')
const { UPLOADS_DIR } = require('../lib/uploads')
const {
  buildReviewPointStatuses,
} = require('../lib/reviewPointStatus')
const {
  rebalanceStudentCourseStatuses,
} = require('../lib/studentCourseStatus')

router.use(auth('teacher'))

const materialStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.dat'
    cb(null, `${uuidv4()}${ext}`)
  },
})
const uploadMaterial = multer({
  storage: materialStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
})

const TASK_COLORS = ['#e8845a', '#6b9e78', '#7b8fc4', '#c4847b', '#9b84c4', '#84b8c4', '#c4b484', '#84c4a4']

function buildDefaultStudyPlan(studentName, courseName, studentId) {
  return [
    {
      day: 1,
      status: 'completed',
      tasks: [{ name: `${courseName} 开班直播`, type: 'live', duration: 60, completed: 1, resources: [] }],
    },
    {
      day: 2,
      status: 'completed',
      tasks: [{
        name: `${courseName} 核心方法课`,
        type: 'video',
        duration: 45,
        completed: 1,
        resources: [
          { resource_type: 'pdf', phase: 'pre', title: `${studentName}-${courseName}-讲义`, url: null, video_id: null },
          { resource_type: 'video', phase: 'main', title: `${courseName} 方法讲解`, url: null, video_id: `video_${studentId}_core` },
        ],
      }],
    },
    {
      day: 3,
      status: 'completed',
      tasks: [{ name: `${courseName} 课堂练习`, type: 'practice', duration: 40, completed: 1, resources: [] }],
    },
    {
      day: 4,
      status: 'in_progress',
      tasks: [
        { name: `${courseName} 课后作业 1`, type: 'practice', duration: 35, completed: 1, resources: [] },
        {
          name: `${courseName} 错题讲评`,
          type: 'review',
          duration: 20,
          completed: 0,
          resources: [{ resource_type: 'video', phase: 'post', title: `${courseName} 复盘视频`, url: null, video_id: `video_${studentId}_review` }],
        },
      ],
    },
    {
      day: 5,
      status: 'pending',
      tasks: [{ name: `${courseName} 课后作业 2`, type: 'submit', duration: 20, completed: 0, resources: [] }],
    },
  ]
}

function normalizeAssignedTheoryLesson(lesson = {}) {
  return {
    id: String(lesson.id || '').trim(),
    title: String(lesson.title || '').trim(),
    videoId: String(lesson.videoId || '').trim(),
    preClassUrl: String(lesson.preClassUrl || '').trim(),
    analysisUrl: String(lesson.analysisUrl || '').trim(),
  }
}

function buildAssignedTheoryResources(lesson, titlePrefix) {
  const resources = []

  if (lesson.preClassUrl) {
    resources.push({
      resource_type: 'pdf',
      phase: 'pre',
      title: `${titlePrefix} 课前讲义`,
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
      title: `${titlePrefix} 课后资料`,
      url: lesson.analysisUrl,
      video_id: null,
    })
  }

  return resources
}

function buildAssignedTheoryStudyPlanDays(courseName, theoryLessons = []) {
  const lessons = Array.isArray(theoryLessons) ? theoryLessons : []
  const days = [
    {
      dayNumber: 1,
      status: 'in_progress',
      tasks: [
        {
          name: '1v1共识课',
          description: `${courseName} 理论阶段第 1 步：先完成 1v1共识、课后反馈与回顾笔记。`,
          type: 'review',
          duration: 15,
          completed: 0,
          sortOrder: 0,
          resources: [],
        },
      ],
    },
  ]

  lessons.forEach((lesson, index) => {
    const roundNumber = index + 1
    const titlePrefix = lesson.title || `${courseName} 第 ${roundNumber} 轮`
    days.push({
      dayNumber: days.length + 1,
      status: 'pending',
      tasks: [
        {
          name: `${titlePrefix} 理论课`,
          description: `${courseName} 第 ${roundNumber} 轮：课前讲义、理论课、课后作业、视频讲解。`,
          type: 'video',
          duration: 45,
          completed: 0,
          sortOrder: 0,
          resources: buildAssignedTheoryResources(lesson, titlePrefix),
        },
      ],
    })
  })

  days.push({
    dayNumber: days.length + 1,
    status: 'pending',
    tasks: [
      {
        name: '思维导图与老师点评',
        description: `${courseName} 理论阶段：上传思维导图并等待老师点评。`,
        type: 'review',
        duration: 20,
        completed: 0,
        sortOrder: 0,
        resources: [],
      },
    ],
  })

  days.push({
    dayNumber: days.length + 1,
    status: 'pending',
    tasks: [
      {
        name: '1v1纠偏课',
        description: `${courseName} 理论阶段最后一步：完成 1v1纠偏、回顾笔记、作业上传与批改反馈。`,
        type: 'review',
        duration: 45,
        completed: 0,
        sortOrder: 0,
        resources: [],
      },
    ],
  })

  return days
}

async function resetStudyPlanForCourse(conn, studentId, courseId) {
  await conn.query(
    `DELETE tr
     FROM task_resources tr
     JOIN study_tasks st ON tr.task_id = st.id
     JOIN study_days sd ON st.study_day_id = sd.id
     WHERE sd.student_id = ?
       AND sd.course_id = ?`,
    [studentId, courseId],
  )

  await conn.query(
    `DELETE st
     FROM study_tasks st
     JOIN study_days sd ON st.study_day_id = sd.id
     WHERE sd.student_id = ?
       AND sd.course_id = ?`,
    [studentId, courseId],
  )

  await conn.query(
    'DELETE FROM study_days WHERE student_id = ? AND course_id = ?',
    [studentId, courseId],
  )
}

async function upsertStudyDay(conn, studentId, courseId, dayNumber, status) {
  await conn.query(
    `INSERT INTO study_days (student_id, course_id, day_number, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status)`,
    [studentId, courseId, dayNumber, status],
  )

  const [[studyDay]] = await conn.query(
    'SELECT id FROM study_days WHERE student_id = ? AND course_id = ? AND day_number = ? LIMIT 1',
    [studentId, courseId, dayNumber],
  )

  return studyDay
}

async function upsertStudyTask(conn, studyDayId, task) {
  await conn.query(
    `INSERT INTO study_tasks (study_day_id, name, description, type, duration_min, completed, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       type = VALUES(type),
       duration_min = VALUES(duration_min),
       completed = VALUES(completed)`,
    [studyDayId, task.name, task.description || null, task.type, task.duration, task.completed, task.sortOrder],
  )

  const [[studyTask]] = await conn.query(
    'SELECT id FROM study_tasks WHERE study_day_id = ? AND sort_order = ? LIMIT 1',
    [studyDayId, task.sortOrder],
  )

  return studyTask
}

async function replaceTaskResources(conn, taskId, resources = []) {
  await conn.query('DELETE FROM task_resources WHERE task_id = ?', [taskId])

  for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex += 1) {
    const resource = resources[resourceIndex]
    await conn.query(
      'INSERT INTO task_resources (task_id, resource_type, phase, title, url, video_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [taskId, resource.resource_type, resource.phase, resource.title, resource.url, resource.video_id, resourceIndex],
    )
  }
}

async function syncAssignedTheoryLessonsToStudyPlan(conn, studentId, courseId, courseName, theoryLessons = []) {
  const lessons = Array.isArray(theoryLessons)
    ? theoryLessons
      .map((lesson) => normalizeAssignedTheoryLesson(lesson))
      .filter((lesson) => lesson.videoId || lesson.preClassUrl || lesson.analysisUrl)
    : []

  if (!lessons.length) {
    return false
  }

  await resetStudyPlanForCourse(conn, studentId, courseId)

  const dayPlan = buildAssignedTheoryStudyPlanDays(courseName, lessons)
  for (const day of dayPlan) {
    const studyDay = await upsertStudyDay(conn, studentId, courseId, day.dayNumber, day.status)
    for (const task of day.tasks) {
      const studyTask = await upsertStudyTask(conn, studyDay.id, task)
      await replaceTaskResources(conn, studyTask.id, task.resources || [])
    }
  }

  return true
}

async function ensureStudyPlan(conn, studentId, courseId, studentName, courseName, theoryLessons = []) {
  const syncedAssignedResources = await syncAssignedTheoryLessonsToStudyPlan(
    conn,
    studentId,
    courseId,
    courseName,
    theoryLessons,
  )

  if (syncedAssignedResources) {
    return
  }

  const [[existingStudyDay]] = await conn.query(
    `SELECT id
     FROM study_days
     WHERE student_id = ? AND course_id = ?
     LIMIT 1`,
    [studentId, courseId],
  )

  if (existingStudyDay) {
    return
  }

  const dayPlan = buildDefaultStudyPlan(studentName, courseName, studentId)

  for (const day of dayPlan) {
    await conn.query(
      'INSERT INTO study_days (student_id, course_id, day_number, status) VALUES (?, ?, ?, ?)',
      [studentId, courseId, day.day, day.status],
    )
    const [[studyDay]] = await conn.query(
      'SELECT id FROM study_days WHERE student_id = ? AND course_id = ? AND day_number = ?',
      [studentId, courseId, day.day],
    )

    for (let index = 0; index < day.tasks.length; index += 1) {
      const task = day.tasks[index]
      const [taskResult] = await conn.query(
        'INSERT INTO study_tasks (study_day_id, name, description, type, duration_min, completed, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [studyDay.id, task.name, task.description || null, task.type, task.duration, task.completed, index],
      )

      for (let resourceIndex = 0; resourceIndex < task.resources.length; resourceIndex += 1) {
        const resource = task.resources[resourceIndex]
        await conn.query(
          'INSERT INTO task_resources (task_id, resource_type, phase, title, url, video_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [taskResult.insertId, resource.resource_type, resource.phase, resource.title, resource.url, resource.video_id, resourceIndex],
        )
      }
    }
  }
}

async function findOrCreateCourse(conn, courseName, subject = '') {
  const safeCourseName = normalizeCheckpointName(courseName)
  const [[existingCourse]] = await conn.query(
    `SELECT id, name, subject
     FROM courses
     WHERE name = ?
     ORDER BY id ASC
     LIMIT 1`,
    [safeCourseName],
  )

  if (existingCourse) {
    return existingCourse
  }

  const safeSubject = String(subject || '').trim() || '申论'
  const [result] = await conn.query(
    `INSERT INTO courses (name, subject, description, price)
     VALUES (?, ?, ?, ?)`,
    [safeCourseName, safeSubject, `${safeCourseName} 学习课程`, 1080],
  )

  return {
    id: result.insertId,
    name: safeCourseName,
    subject: safeSubject,
  }
}

async function ensureStudentCourseEnrollment(conn, teacherId, studentId, checkpointName, theoryLessons = [], sortOrder = 0) {
  const safeCheckpointName = normalizeCheckpointName(checkpointName)
  if (!safeCheckpointName) return null

  const [[studentRow]] = await conn.query(
    `SELECT s.name, COALESCE(ts.subject, '') AS subject
     FROM students s
     LEFT JOIN teacher_students ts
       ON ts.student_id = s.id
      AND ts.teacher_id = ?
     WHERE s.id = ?
     LIMIT 1`,
    [teacherId, studentId],
  )

  const course = await findOrCreateCourse(conn, safeCheckpointName, studentRow && studentRow.subject)

  const initialStatus = sortOrder === 0 ? 'in_progress' : 'pending'

  await conn.query(
    `INSERT INTO student_courses (student_id, course_id, progress, status, sort_order)
     VALUES (?, ?, 0, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       sort_order = VALUES(sort_order),
       progress = CASE
         WHEN status IN ('completed', 'failed') OR progress >= 100 THEN 0
         ELSE LEAST(progress, 99)
       END,
       created_at = NOW()`,
    [studentId, course.id, initialStatus, sortOrder],
  )

  await ensureStudyPlan(
    conn,
    studentId,
    course.id,
    String((studentRow && studentRow.name) || '学生'),
    String(course.name || safeCheckpointName),
    theoryLessons,
  )

  return course
}

function readJsonArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function inferTeamRoleFromTitle(title) {
  const value = String(title || '')
  if (value.includes('\u6821\u957f') || value.toLowerCase().includes('principal')) return 'principal'
  if (value.includes('\u5b66\u7ba1') || value.toLowerCase().includes('manager')) return 'manager'
  if (value.includes('\u8bca\u65ad') || value.toLowerCase().includes('diagnosis')) return 'diagnosis'
  return 'coach'
}

function mapTeamRoleLabel(role) {
  switch (role) {
    case 'principal':
      return '\u6821\u957f'
    case 'manager':
      return '\u5b66\u7ba1'
    case 'diagnosis':
      return '\u8bca\u65ad\u8001\u5e08'
    default:
      return '\u5e26\u6559\u8001\u5e08'
  }
}

async function ensureTeacherStudentRelation(conn, teacherId, studentId, subject = '', grade = '') {
  if (!teacherId || !studentId) return

  await conn.query(
    `INSERT INTO teacher_students (teacher_id, student_id, subject, grade)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       subject = CASE
         WHEN VALUES(subject) <> '' THEN VALUES(subject)
         ELSE subject
       END,
       grade = CASE
         WHEN VALUES(grade) <> '' THEN VALUES(grade)
         ELSE grade
       END`,
    [teacherId, studentId, subject, grade],
  )
}

async function ensureChatRoom(conn, teacherId, studentId) {
  if (!teacherId || !studentId) return

  await conn.query(
    `INSERT INTO chat_rooms (teacher_id, student_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE teacher_id = VALUES(teacher_id)`,
    [teacherId, studentId],
  )
}

function formatDate(value) {
  if (!value) return ''
  if (value instanceof Date) {
    const yyyy = value.getFullYear()
    const mm = String(value.getMonth() + 1).padStart(2, '0')
    const dd = String(value.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return String(value).slice(0, 10)
}

function formatTime(value) {
  if (!value) return ''
  return String(value).slice(0, 5)
}

function formatShortDate(value) {
  const date = formatDate(value)
  return date ? date.slice(5) : ''
}

function avatar(name) {
  return String(name || '学').slice(0, 1)
}

function colorById(id) {
  const index = Math.abs(Number(id) || 0) % TASK_COLORS.length
  return TASK_COLORS[index]
}

function waitText(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  const diffMs = Math.max(0, Date.now() - time)
  const minutes = Math.max(1, Math.floor(diffMs / 60000))
  if (minutes < 60) return `等待 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `等待 ${hours} 小时`
  return `等待 ${Math.floor(hours / 24)} 天`
}

function parseJsonArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapComplaintRow(row) {
  return {
    id: String(row.id),
    studentId: String(row.student_id),
    studentName: String(row.student_name || ''),
    demand: String(row.demand || ''),
    reason: String(row.reason || ''),
    suggestion: String(row.suggestion || ''),
    resolvers: parseJsonArray(row.resolvers_json).map((item) => String(item)),
    deadline: formatDate(row.deadline),
    extraNote: String(row.extra_note || ''),
    attachments: parseJsonArray(row.attachments_json).map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      dataUrl: String(item.dataUrl || ''),
    })),
    submittedBy: String(row.submitted_by_name || ''),
    submittedAt: row.created_at,
    status: row.status === 'resolved' ? 'resolved' : 'pending',
    resolvedAt: row.resolved_at || undefined,
    resolvedNote: row.resolved_note || undefined,
  }
}

async function getPendingClassItems(teacherId) {
  const [rows] = await pool.query(
    `SELECT ce.id, ce.student_id, ce.title, ce.date, ce.start_time, ce.end_time,
            s.name AS student_name, COALESCE(ts.subject, '') AS subject,
            cr.id AS contact_id
     FROM calendar_events ce
     JOIN students s ON s.id = ce.student_id
     JOIN teacher_students ts ON ts.student_id = ce.student_id AND ts.teacher_id = ce.teacher_id
     LEFT JOIN chat_rooms cr ON cr.teacher_id = ce.teacher_id AND cr.student_id = ce.student_id
     WHERE ce.teacher_id = ?
       AND ce.type = 'class'
       AND ce.date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
     ORDER BY ce.date, ce.start_time
     LIMIT 20`,
    [teacherId],
  )

  return rows.map((row) => ({
    id: `class_${row.id}`,
    name: row.student_name,
    subtitle: `${row.title || row.subject || '课程'} · ${formatShortDate(row.date)} ${formatTime(row.start_time)}-${formatTime(row.end_time)}`,
    actionLabel: '查看主页',
    avatar: avatar(row.student_name),
    color: colorById(row.student_id),
    contactId: row.contact_id ? String(row.contact_id) : undefined,
    studentId: String(row.student_id),
    eventId: String(row.id),
  }))
}

async function getPendingReplyItems(teacherId) {
  const [rows] = await pool.query(
    `SELECT cr.id AS room_id, cr.student_id, s.name AS student_name,
            latest.content, latest.created_at
     FROM chat_rooms cr
     JOIN students s ON s.id = cr.student_id
     JOIN (
       SELECT cm.*
       FROM chat_messages cm
       JOIN (
         SELECT room_id, MAX(id) AS max_id
         FROM chat_messages
         GROUP BY room_id
       ) last_msg ON last_msg.max_id = cm.id
     ) latest ON latest.room_id = cr.id
     WHERE cr.teacher_id = ?
       AND latest.sender_type = 'student'
     ORDER BY latest.created_at DESC
     LIMIT 20`,
    [teacherId],
  )

  return rows.map((row) => ({
    id: `reply_${row.room_id}`,
    name: row.student_name,
    subtitle: waitText(row.created_at),
    actionLabel: '立即回复',
    avatar: avatar(row.student_name),
    color: colorById(row.student_id),
    contactId: String(row.room_id),
    studentId: String(row.student_id),
  }))
}

async function getPendingAssignItems(teacherId) {
  const [taskRows] = await pool.query(
    `SELECT pat.id, pat.student_id, pat.checkpoint, pat.detail, s.name AS student_name, cr.id AS contact_id
     FROM practice_assignment_tasks pat
     JOIN students s ON s.id = pat.student_id
     LEFT JOIN chat_rooms cr ON cr.teacher_id = ? AND cr.student_id = pat.student_id
     WHERE pat.teacher_id = ? AND pat.status = 'pending'
     ORDER BY pat.created_at ASC
     LIMIT 20`,
    [teacherId, teacherId],
  )

  const [unassignedRows] = await pool.query(
    `SELECT s.id AS student_id, s.name AS student_name, cr.id AS contact_id
     FROM students s
     JOIN teacher_students ts ON ts.teacher_id = ? AND ts.student_id = s.id
     LEFT JOIN chat_rooms cr ON cr.teacher_id = ? AND cr.student_id = s.id
     WHERE NOT EXISTS (
       SELECT 1 FROM student_courses sc WHERE sc.student_id = s.id
     )
       AND NOT EXISTS (
         SELECT 1 FROM practice_assignment_tasks pat
         WHERE pat.teacher_id = ? AND pat.student_id = s.id AND pat.status = 'pending'
       )
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT ?`,
    [teacherId, teacherId, teacherId, Math.max(0, 20 - taskRows.length)],
  )

  const rows = [
    ...taskRows,
    ...unassignedRows.map((row) => ({
      ...row,
      id: `student_${row.student_id}`,
      checkpoint: '',
      detail: '',
    })),
  ]

  return rows.map((row) => ({
    id: `assign_${row.id}`,
    name: row.student_name,
    subtitle: `${normalizeCheckpointName(row.checkpoint || '\u5b66\u4e60\u5361\u70b9')} \u00b7 ${row.detail || '\u5f85\u5206\u914d\u7ec3\u4e60\u9898'}`,
    actionLabel: '\u53bb\u5206\u914d',
    avatar: avatar(row.student_name),
    color: colorById(row.student_id),
    contactId: row.contact_id ? String(row.contact_id) : undefined,
    studentId: String(row.student_id),
  }))

  return rows.map((row) => ({
    id: `assign_${row.id}`,
    name: row.student_name,
    subtitle: `${normalizeCheckpointName(row.checkpoint || '学习卡点')} · ${row.detail || '待分配练习题'}`,
    actionLabel: '去分配',
    avatar: avatar(row.student_name),
    color: colorById(row.student_id),
    contactId: row.contact_id ? String(row.contact_id) : undefined,
    studentId: String(row.student_id),
  }))
}

// 3种1v1直播课的任务定义
const LIVE_TASK_DEFS = [
  { courseType: 'diagnose',   liveTaskId: 'diagnose_live',          replayTaskId: 'diagnose_replay',          stageKey: 'diagnose', label: '1v1诊断' },
  { courseType: 'consensus',  liveTaskId: 'theory_consensus_live',  replayTaskId: 'theory_consensus_replay',  stageKey: 'theory',   label: '1v1共识' },
  { courseType: 'correction', liveTaskId: 'theory_correction_live', replayTaskId: 'theory_correction_replay', stageKey: 'theory',   label: '1v1纠偏' },
]

async function getPendingLinkItems(teacherId) {
  const taskIds = LIVE_TASK_DEFS.flatMap((d) => [d.liveTaskId, d.replayTaskId])
  const [rows] = await pool.query(
    `SELECT
       ts.student_id,
       s.name AS student_name,
       cr.id AS contact_id,
       c.name AS point_name,
       slpt.task_id,
       slpt.meta_json
     FROM teacher_students ts
     JOIN students s ON s.id = ts.student_id
     LEFT JOIN chat_rooms cr ON cr.teacher_id = ts.teacher_id AND cr.student_id = ts.student_id
     LEFT JOIN student_courses sc ON sc.student_id = ts.student_id
     LEFT JOIN courses c ON c.id = sc.course_id
     LEFT JOIN student_learning_path_tasks slpt
       ON slpt.student_id = ts.student_id
      AND slpt.task_id IN (${taskIds.map(() => '?').join(',')})
     WHERE ts.teacher_id = ?
     ORDER BY ts.student_id, slpt.task_id`,
    [...taskIds, teacherId],
  )

  // 按学生整理，point_name 来自 student_courses
  const studentMap = new Map()
  for (const row of rows) {
    const sid = String(row.student_id)
    if (!studentMap.has(sid)) {
      studentMap.set(sid, {
        studentId: sid,
        studentName: row.student_name,
        contactId: row.contact_id ? String(row.contact_id) : undefined,
        pointName: row.point_name ? normalizeCheckpointName(row.point_name) : '',
        tasks: {},
      })
    }
    // 如果还没有 pointName，尝试从当前行补充
    if (!studentMap.get(sid).pointName && row.point_name) {
      studentMap.get(sid).pointName = normalizeCheckpointName(row.point_name)
    }
    if (row.task_id) {
      let meta = {}
      try { meta = JSON.parse(row.meta_json || '{}') } catch { meta = {} }
      studentMap.get(sid).tasks[row.task_id] = {
        liveUrl: meta.liveUrl || '',
        replayVideoId: meta.replayVideoId || '',
      }
    }
  }

  const items = []
  for (const student of studentMap.values()) {
    // 没有分配课程的学生跳过
    if (!student.pointName) continue

    for (const def of LIVE_TASK_DEFS) {
      const liveTask   = student.tasks[def.liveTaskId]
      const replayTask = student.tasks[def.replayTaskId]

      const base = {
        name: student.studentName,
        subtitle: `${def.label} · ${student.pointName}`,
        avatar: avatar(student.studentName),
        color: colorById(student.studentId),
        contactId: student.contactId,
        studentId: student.studentId,
        courseType: def.courseType,
        pointName: student.pointName,
      }

      // 直播链接：没有任务记录 或 有记录但 liveUrl 为空 → 显示上传
      if (!liveTask || !liveTask.liveUrl) {
        items.push({ ...base, id: `live_${student.studentId}_${def.courseType}`, actionLabel: '上传直播链接', linkType: 'live' })
      }
      // 录播链接：没有任务记录 或 有记录但 replayVideoId 为空 → 显示上传
      if (!replayTask || !replayTask.replayVideoId) {
        items.push({ ...base, id: `replay_${student.studentId}_${def.courseType}`, actionLabel: '上传录播链接', linkType: 'replay' })
      }
    }
  }
  return items
}

async function getNewStudentItems(teacherId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.name, s.created_at, COALESCE(ts.grade, '') AS grade, COALESCE(ts.subject, '') AS subject,
            cr.id AS contact_id
     FROM teacher_students ts
     JOIN students s ON s.id = ts.student_id
     LEFT JOIN chat_rooms cr ON cr.teacher_id = ts.teacher_id AND cr.student_id = s.id
     WHERE ts.teacher_id = ? AND s.status = 'new'
     ORDER BY s.created_at DESC
     LIMIT 20`,
    [teacherId],
  )

  return rows.map((row) => ({
    id: `new_${row.id}`,
    name: row.name,
    subtitle: `年级：${row.grade || '未填写'} · ${row.subject || '待确认'} · 新学员`,
    actionLabel: '去跟进',
    avatar: avatar(row.name),
    color: colorById(row.id),
    contactId: row.contact_id ? String(row.contact_id) : undefined,
    studentId: String(row.id),
  }))
}

const HANDOUT_TASK_IDS = [
  'theory_handout',
  'theory_round_1_handout',
  'theory_round_2_handout',
  'theory_round_3_handout',
]

async function getPendingHandoutItems(teacherId) {
  const placeholders = HANDOUT_TASK_IDS.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT ts.student_id, s.name AS student_name, cr.id AS contact_id,
            slpt.id AS task_row_id, slpt.task_id, slpt.point_name, slpt.stage_key
     FROM teacher_students ts
     JOIN students s ON s.id = ts.student_id
     LEFT JOIN chat_rooms cr ON cr.teacher_id = ts.teacher_id AND cr.student_id = ts.student_id
     JOIN student_learning_path_tasks slpt
       ON slpt.student_id = ts.student_id
      AND slpt.task_id IN (${placeholders})
     LEFT JOIN lesson_materials lm
       ON lm.student_id = ts.student_id
      AND lm.point_name = slpt.point_name
      AND lm.stage_key  = slpt.stage_key
      AND lm.task_id    = slpt.task_id
      AND lm.material_type = 'handout'
     WHERE ts.teacher_id = ?
       AND lm.id IS NULL
     ORDER BY ts.student_id, slpt.task_id
     LIMIT 20`,
    [...HANDOUT_TASK_IDS, teacherId],
  )

  const TASK_LABEL = {
    theory_handout: '理论课讲义',
    theory_round_1_handout: '第1轮理论课讲义',
    theory_round_2_handout: '第2轮理论课讲义',
    theory_round_3_handout: '第3轮理论课讲义',
  }

  return rows.map((row) => ({
    id: `handout_${row.task_row_id}`,
    name: row.student_name,
    subtitle: `${row.point_name} · ${TASK_LABEL[row.task_id] || '讲义'}未上传`,
    actionLabel: '上传讲义',
    avatar: avatar(row.student_name),
    color: colorById(row.student_id),
    contactId: row.contact_id ? String(row.contact_id) : undefined,
    studentId: String(row.student_id),
    taskRowId: String(row.task_row_id),
  }))
}
async function getPendingFeedbackItems() {
  await ensureStudentFeedbackTable()

  const [rows] = await pool.query(
    `SELECT sf.id, sf.student_id, sf.source, sf.title, sf.point_name, sf.created_at,
            s.name AS student_name
     FROM student_feedback_messages sf
     JOIN students s ON s.id = sf.student_id
     WHERE sf.status = 'pending'
     ORDER BY sf.created_at DESC, sf.id DESC
     LIMIT 20`
  )

  return rows.map((row) => {
    const sourceLabel = getFeedbackSourceLabel(row.source)
    const contextLabel = String(row.point_name || row.title || '').trim()

    return {
      id: `feedback_${row.id}`,
      name: row.student_name,
      subtitle: contextLabel ? `${sourceLabel} · ${contextLabel}` : sourceLabel,
      actionLabel: '查看反馈',
      avatar: avatar(row.student_name),
      color: colorById(row.student_id),
      studentId: String(row.student_id),
      feedbackId: String(row.id),
    }
  })
}

async function getTeacherTaskItems(teacherId) {
  const [
    pendingClass,
    pendingReply,
    pendingAssign,
    pendingLink,
    newStudent,
    pendingHandout,
    pendingFeedback,
  ] = await Promise.all([
    getPendingClassItems(teacherId),
    getPendingReplyItems(teacherId),
    getPendingAssignItems(teacherId),
    getPendingLinkItems(teacherId),
    getNewStudentItems(teacherId),
    getPendingHandoutItems(teacherId),
    getPendingFeedbackItems(),
  ])

  return {
    pendingClass,
    pendingReply,
    abnormalUser: [],
    pendingReview: [],
    pendingLeave: [],
    pendingAssign,
    pendingLink,
    newStudent,
    pendingHandout,
    pendingFeedback,
  }
}

// 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌熼梻瀵割槮缁惧墽绮换娑㈠箣濞嗗繒鍔撮梺杞扮椤戝棝濡甸崟顖氱閻犺櫣鍎ら悗楣冩⒑閸涘﹦鎳冪紒缁樺姌閻忓啴姊洪幐搴ｇ畵闁瑰啿閰ｅ鎼佸Χ婢跺鍘告繛杈剧到婢瑰﹪宕曢幋锔界厵闁圭粯甯楅崯鐐烘煙椤栨稒顥堝┑鈩冩倐婵＄柉顦撮柡澶夌矙濮婄粯绗熼埀顒€顭囪婢ф繈姊洪崫鍕櫤缂侇喗鎸搁悾鐑藉箣閿曗偓缁€瀣亜閺嶃劎銆掗柛妯圭矙濮婅櫣鎲撮崟顐㈠Б闂佸摜鍠庡锟犮€佸Δ鍛潊闁靛牆妫涢崢浠嬫煙閸忓吋鍎楅柛鐘崇墬閺呭爼顢涘鍛紲缂傚倷鐒﹂…鍥虹€电硶鍋撳▓鍨灈闁绘牕銈搁悰顔锯偓锝庝簴閺€浠嬫煕閵夋垟鍋撻柛瀣崌椤㈡稑顫濋敐鍡樻澑闂備胶绮崝鏍亹閸愵喖绠栭柟杈鹃檮閻撶喖鏌ｉ弮鈧娆撳礉閿曞倹鐓曢柍鐟扮仢閻忊晜銇勯幘鍐叉倯鐎垫澘瀚换娑㈠煕閳ь剟宕堕妸褍骞堥梻浣规灱閺呮盯宕㈡ィ鍐炬晜闁告洟娼у▓銊╂⒑缁夊棗瀚峰▓鏇㈡煃闁垮鐏撮柡灞剧洴閺佸倻鎷犻幓鎺旑啇闂備礁鎲￠弻銊╊敄婢舵劕钃熸繛鎴欏灩鎯熼悷婊冮叄瀵娊顢楅崟顒傚幈闂佸疇顫夐崕铏閻愵兛绻嗛柣鎰典簻閳ь剚鐗犲畷褰掓偂鎼存ɑ鐏冮梺鍝勬储閸ㄦ椽宕曞Δ浣虹闁糕剝蓱鐏忎即鏌?
router.get('/tasks/count', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [[pendingGrade]] = await pool.query(
      `SELECT COUNT(DISTINCT ps.id) as count
       FROM pdf_submissions ps
       JOIN teacher_students ts ON ts.student_id = ps.student_id
       WHERE ps.graded = 0 AND ts.teacher_id = ?`,
      [teacherId])
    const [[pendingLeave]] = await pool.query(
      `SELECT COUNT(*) as count
       FROM leave_requests lr
       JOIN teacher_students ts ON ts.student_id = lr.student_id
       WHERE ts.teacher_id = ? AND lr.status = 'pending'`,
      [teacherId])
    const [[newStudents]] = await pool.query(
      `SELECT COUNT(*) as count FROM teacher_students ts
       JOIN students s ON ts.student_id = s.id
       WHERE ts.teacher_id = ? AND s.status = 'new'`,
      [teacherId])
    const [[abnormal]] = await pool.query(
      'SELECT COUNT(*) as count FROM student_flags WHERE teacher_id = ? AND flagged = 1',
      [teacherId])
    const taskItems = await getTeacherTaskItems(teacherId)
    res.json({
      pendingClass: taskItems.pendingClass.length,
      pendingReply: taskItems.pendingReply.length,
      pendingGrade: pendingGrade.count,
      pendingLeave: pendingLeave.count,
      newStudents: newStudents.count,
      abnormal: abnormal.count,
      pendingAssign: taskItems.pendingAssign.length,
      pendingLink: taskItems.pendingLink.length,
      pendingHandout: taskItems.pendingHandout.length,
      pendingFeedback: taskItems.pendingFeedback.length,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌熼梻瀵割槮缁惧墽绮换娑㈠箣濞嗗繒鍔撮梺杞扮椤戝棝濡甸崟顖氱閻犺櫣鍎ら悗楣冩⒑閸涘﹦鎳冪紒缁橈耿瀵鎮㈤搹鍦紲闂侀潧绻掓慨鐢告倶瀹ュ鈷戦柛婵嗗閸ｈ櫣绱掔拠鑼ⅵ鐎殿喖顭峰鎾偄妞嬪海鐛梻浣稿閸嬪懐鎹㈤崒娑氱彾闁哄倸绨遍弨浠嬫煟閹邦厽缍戦柣蹇曞枛閺屾盯濡搁妷褏楔闂佽鍠掗埀顒佹灱濡插牓鏌曡箛銉х？闁告﹢浜堕弻锝堢疀閺囩偘绮舵繝鈷€鍌滅煓闁诡垰鐭傛俊鍫曞幢濞嗘埈鍟庨梻浣告惈椤︿即宕归悽鍓叉晜妞ゆ挶鍨洪悡娑氣偓鍏夊亾閻庯綆鍓涜ⅵ闂備浇顕栭崰鎺楀疾閻樿尙鏆﹂柨婵嗘缁剁偛鈹戦悩鎻掝劉鐞氣晠姊绘担钘夊惞闁哥姵鍔楅崚鎺戭吋閸滀胶鍞靛┑顔姐仜閸嬫挾鈧娲﹂崹鍫曠嵁濮椻偓椤㈡瑩鎳為妷锔惧礁闂傚倷鑳剁划顖炲礉閺囥垹绠规い鎰╁灪缁绢垱绻濋悽闈浶為柛銊у帶閳绘柨鈽夐姀鈺傛櫈闂佹悶鍎洪崜娆撳磼閵娾晜鐓㈡俊顖欒濡牊绻涢幘鎰佺吋闁哄本娲熷畷鐓庘攽閸パ勵仱缂傚倷鑳舵慨閿嬫櫠濡や胶鈹嶅┑鐘叉祩閺佸啴鏌ㄥ┑鍡楊劉闁汇倓绶氶幃妤€鈻撻崹顔界亪闂佺顕滅换婵嬬嵁閸℃稑绫嶉柛顐ｆ儕閳哄懏鐓ラ柡鍐ｅ亾闁稿孩濞婇悰顔嘉旈崨顔规嫽婵炴挻鍩冮崑鎾寸箾娴ｅ啿娲﹂崑瀣煕閳╁啰鈽夌紒鐘靛█楠炴牠骞栭鐘插弗闂佽桨绀侀崐褰掑Φ閸曨垰绠婚悹铏规磪濞戙垺鐓曢悗锝庡亝鐏忕敻鏌熼崣澶嬪唉鐎规洜鍠栭、妤呭磼閵堝柊鐐烘⒒閸屾瑦绁板鐟扮墦閿濈偞寰勬繝鍕濠殿喗銇涢崑鎾绘煙椤旀枻鑰跨€规洘锕㈤、娆戞喆閿濆棗顏归梻鍌欑閹诧紕绮欓幋锔芥櫇闁靛／鍐炬闂佹眹鍨归幉锟犳偂濞戙垺鐓曢悘鐐插⒔閹冲懐绱掗幇顓熲拻闁?
router.get('/tasks/items', async (req, res) => {
  try {
    const items = await getTeacherTaskItems(req.user.id)
    res.json(items)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/dashboard-summary', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [[teacherStats]] = await pool.query(`
      SELECT COUNT(*) AS total_teachers
      FROM teachers
    `)

    const [[studentStats]] = await pool.query(`
      SELECT
        COUNT(DISTINCT s.id) AS total_students,
        COUNT(DISTINCT CASE WHEN (s.phone IS NOT NULL AND s.phone <> '') OR (s.account IS NOT NULL AND s.account <> '') THEN s.id END) AS registered_students,
        COUNT(DISTINCT CASE WHEN s.status = 'new' THEN s.id END) AS new_students,
        COUNT(DISTINCT CASE WHEN s.status = 'normal' THEN s.id END) AS normal_students
      FROM teacher_students ts
      JOIN students s ON s.id = ts.student_id
      WHERE ts.teacher_id = ?
    `, [teacherId])

    const [recentTeachers] = await pool.query(`
      SELECT id, name, email, title, created_at
      FROM teachers
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `)

    const [recentStudents] = await pool.query(`
      SELECT DISTINCT s.id, s.name, s.phone, s.account, s.status, s.created_at
      FROM teacher_students ts
      JOIN students s ON s.id = ts.student_id
      WHERE ts.teacher_id = ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 10
    `, [teacherId])

    res.json({
      stats: {
        totalTeachers: Number(teacherStats.total_teachers || 0),
        totalStudents: Number(studentStats.total_students || 0),
        registeredStudents: Number(studentStats.registered_students || 0),
        newStudents: Number(studentStats.new_students || 0),
        normalStudents: Number(studentStats.normal_students || 0),
      },
      recentTeachers,
      recentStudents,
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/student-feedbacks', async (req, res) => {
  const status = String(req.query.status || '').trim()

  try {
    await ensureStudentFeedbackTable()

    const where = ['1 = 1']
    const params = []

    if (status === 'pending' || status === 'read') {
      where.push('sf.status = ?')
      params.push(status)
    }

    const [rows] = await pool.query(
      `SELECT sf.id, sf.student_id, sf.source, sf.title, sf.point_name, sf.course_id,
              sf.content, sf.attachments_json, sf.meta_json, sf.status,
              sf.reviewed_at, sf.created_at, s.name AS student_name, s.phone AS student_phone,
              t.name AS reviewed_by_name
       FROM student_feedback_messages sf
       JOIN students s ON s.id = sf.student_id
       LEFT JOIN teachers t ON t.id = sf.reviewed_by
       WHERE ${where.join(' AND ')}
       ORDER BY FIELD(sf.status, 'pending', 'read'), sf.created_at DESC, sf.id DESC`,
      params,
    )

    res.json(rows.map(mapStudentFeedbackRow))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.patch('/student-feedbacks/:id/read', async (req, res) => {
  const teacherId = req.user.id

  try {
    await ensureStudentFeedbackTable()

    const [[current]] = await pool.query(
      `SELECT sf.id, sf.status
       FROM student_feedback_messages sf
       WHERE sf.id = ?
       LIMIT 1`,
      [req.params.id],
    )

    if (!current) {
      return res.status(404).json({ message: '????' })
    }

    if (current.status !== 'read') {
      await pool.query(
        `UPDATE student_feedback_messages
         SET status = 'read', reviewed_by = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [teacherId, req.params.id],
      )
    }

    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/checkpoint-theory-library', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         checkpoint_name,
         knowledge_point,
         knowledge_type,
         learning_status_raw,
         province_tags_json,
         course_status,
         theory_title,
         video_id,
         pre_class_url,
         analysis_url,
         note_text,
         source_sheet,
         source_row,
         sort_order
       FROM checkpoint_theory_library
       ORDER BY checkpoint_name ASC, sort_order ASC, id ASC`
    )

    res.json(rows.map((row) => ({
      checkpointName: normalizeCheckpointName(row.checkpoint_name),
      knowledgePoint: String(row.knowledge_point || ''),
      knowledgeType: row.knowledge_type === 'optional' ? 'optional' : 'required',
      learningStatusRaw: String(row.learning_status_raw || ''),
      provinceTags: readJsonArray(row.province_tags_json).map((item) => String(item || '').trim()).filter(Boolean),
      courseStatus: String(row.course_status || ''),
      theoryTitle: String(row.theory_title || ''),
      videoId: String(row.video_id || ''),
      preClassUrl: String(row.pre_class_url || ''),
      analysisUrl: String(row.analysis_url || ''),
      noteText: String(row.note_text || ''),
      sourceSheet: String(row.source_sheet || ''),
      sourceRow: Number(row.source_row || 0),
      sortOrder: Number(row.sort_order || 0),
    })))
  } catch (err) {
    if (isMissingTableError(err)) {
      return res.json([])
    }
    res.status(500).json({ message: err.message })
  }
})

router.get('/assignable-teachers', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, COALESCE(title, '') AS title
       FROM teachers
       ORDER BY id ASC`,
    )

    res.json(
      rows.map((row) => {
        const role = inferTeamRoleFromTitle(row.title)
        return {
          id: String(row.id),
          name: String(row.name || ''),
          title: String(row.title || ''),
          role,
          roleLabel: mapTeamRoleLabel(role),
          color: colorById(row.id),
        }
      }),
    )
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹瀹勬噴褰掑炊椤掑鏅悷婊冮叄閵嗗啴濡烽埡浣侯啇婵炶揪绲块幊鎾诲焵椤掑啫鐓愰柟渚垮妼椤粓宕卞Δ鈧埛鎺楁⒑缂佹ɑ鐓ユ俊顐ｇ懇楠炲牓濡搁妷顔藉瘜闁荤姴娲╁鎾寸珶閺囩喍绻嗛柕鍫濇搐鍟搁梺绋款儐閻╊垶寮崘顔嘉ㄩ柍杞拌兌閻ｉ箖姊洪崫鍕殭闁绘鍟撮崺鈧い鎺戯功閻ｅ灚顨ラ悙宸剶闁诡喗鐟ч埀顒佺⊕椤洩銇愭惔銊︹拻闁稿本鑹鹃埀顒勵棑缁牊鎷呴搹鍦槸婵犵數濮存导锝呪槈濮橆厼纾梺闈浤涢崨顖氬Ц婵犵數鍋犻幓顏嗙礊閳ь剚绻涢崪鍐ɑ缂佸顦鍏煎緞鐎ｎ剙甯惧┑鐘灱椤曟牠宕规导鏉戠疇闊洦绋掗弲顒勭叓閸ャ劍鎯勬繛鎾愁煼閺屾洟宕煎┑鍥舵！闁诲繐绻掗弫濠氬蓟濞戞埃鍋撻敐搴″濞寸媴绠撻弻娑㈠箳閹搭垱鏁剧紓浣芥〃缁瑥鐣烽妸锔剧瘈闁告洦鍋勭粻鐐烘⒒閸屾瑧绐旀繛浣冲洦鍋嬮柛鈩冾樅濞差亜围闁糕剝鐟ù鍕⒒娓氬洤澧紒澶屾暬閹€斥槈閵忊€斥偓鍫曟煟閹邦厼绲婚柍閿嬫閺屾洟宕卞Ο鐑樿癁闂佸搫鑻粔鐑铰ㄦ笟鈧弻娑㈠箻閸楃偛顬嬬紓浣戒含閸嬨倕鐣烽崡鐐嶇喓鍠婃潏銊╂暅濠电姷鏁告繛鈧繛浣冲浂鏁勯柛娑卞灣娑撳秶鎲搁悧鍫濈瑲闁绘挻鐟╅弻鐔封枔閸喗鐏堝銈忕到閵堟悂寮婚敐澶婄閻庢稒顭囬ˇ銊╂⒑闂堟稒鎼愰悗姘嵆閵嗕礁顫滈埀顒勫箖閵忊槅妲归幖瀛樼箓鐎佃尙绱撻崒姘偓鐑芥⒔瀹ュ绀夐悗锝庡墮閸ㄦ繃绻涢崱妯诲碍闁?
router.get('/leave-requests', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(
      `SELECT lr.id, lr.student_id, s.name AS student_name, lr.type, lr.course_id,
              lr.point_name, lr.step_name, lr.days, lr.reason, lr.status, lr.created_at,
              c.name AS course_name
       FROM leave_requests lr
       JOIN students s ON s.id = lr.student_id
       JOIN teacher_students ts ON ts.student_id = lr.student_id
       LEFT JOIN courses c ON c.id = lr.course_id
       WHERE ts.teacher_id = ? AND lr.status = 'pending'
       ORDER BY lr.created_at ASC`,
      [teacherId]
    )
    res.json(rows.map((row) => ({
      ...row,
      point_name: normalizeCheckpointName(row.point_name),
      course_name: normalizeCheckpointName(row.course_name),
    })))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾圭€瑰嫭鍣磋ぐ鎺戠倞妞ゆ帒顦伴弲顏堟偡濠婂啴鍙勯柕鍡楀暣婵＄兘鍩℃担渚晣濠电偠鎻徊鍧椻€﹂崼銉ョ；鐎广儱鎳夐弨浠嬫煟濡鍤嬬€规悶鍎甸弻锝呂旈埀顒€螞濞戞艾鍨濋柛顐犲劚闁卞洭鏌ｉ弮鍥仩闁伙箑鐗撳濠氬磼濮樺崬顤€缂備礁顑嗙敮鎺楊敊韫囨挴鏀介悗锝庡亞閸樿棄鈹戦悩缁樻锭婵☆偅鐩畷娲晲婢跺鍘搁悗鍏夊亾闁逞屽墴瀹曚即寮介鐐电暫濠电姴锕ら崰姘焽閵娾晜鐓曢柍鈺佸枤閻掍粙鏌￠崱鎰姦婵﹥妞介幊锟犲Χ閸涱喚鈧箖姊洪懡銈呮灆濞存粠鍓涢崚鎺撶節濮橆剛顔掗柣鐘叉穿鐏忔瑩鎮鹃崫鍕ㄦ斀妞ゆ柨顫曟禒婊堟煕鐎ｎ偅宕岄柡宀€鍠栭、娆撴偩鐏炴儳娅氶柣搴㈩問閸犳牠鎮ユ總鍝ュ祦閻庯綆浜栭弨浠嬫煕閻橀潧顣奸柛銊ф暬閸╃偤骞嬮敂钘変汗濡炪倖妫侀崑鎰閸曨垱鈷戠痪顓炴噺閻濐亪鏌熼悷鐗堝枠妤犵偛鍟抽ˇ瑙勵殽閻愭惌鐒介柟椋庡█閹崇娀顢楅崒娑欑槖闂備浇宕甸崰鎰垝鎼淬垺娅犳俊銈呭暞閺嗘粓鏌熼悜姗嗘畷闁稿﹤鍢查埞鎴︽偐閹绘帩浠鹃梺鍝ュУ閸旀鍩€椤掆偓缁犲秹宕曢柆宥呯疅婵せ鍋撻柡浣瑰姍瀹曞爼濡搁妷褍閰遍梻?
router.put('/leave-requests/:id/approve', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [[leave]] = await pool.query(
      `SELECT lr.id, lr.student_id, lr.point_name, lr.step_name, lr.days
       FROM leave_requests lr
       JOIN teacher_students ts ON ts.student_id = lr.student_id
       WHERE lr.id = ? AND ts.teacher_id = ? AND lr.status = 'pending'
       LIMIT 1`,
      [req.params.id, teacherId]
    )

    if (!leave) {
      return res.status(404).json({ message: '????' })
    }

    await pool.query(
      `UPDATE leave_requests
       SET status = 'approved', reviewed_by = ?, approved_at = NOW()
       WHERE id = ?`,
      [teacherId, req.params.id]
    )

    await pool.query(
      `INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at)
       VALUES (?, 'leave', ?, ?, 'leave_request', ?, NOW())`,
      [
        leave.student_id,
        '请假申请已通过',
        `你的请假申请已通过${leave.point_name ? `，卡点：${leave.point_name}` : ''}`,
        String(leave.id),
      ]
    )

    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹瀹勬噴褰掑炊椤掑鏅悷婊冪箻閸┾偓妞ゆ帊鑳堕埢鎾绘煛閸涱垰鈻堥柕鍡曠閳诲酣骞橀崘鎻掓暏婵＄偑鍊栭幐楣冨磻閻斿吋鍋橀柕澶嗘櫆閳锋垿鏌涘┑鍡楊伀闁宠顦甸弻娑樜熼崹顔绘睏婵犮垼顫夊ú婵嬪Φ閹版澘绠抽柟鎹愭硾楠炲秹姊婚崒姘偓鎼佸磹閹间緡鏁嬫い鎾卞灩缁€澶屸偓骞垮劚椤︿即鎮￠弴銏″€甸柨婵嗙凹閹茬偓淇婇妤€浜鹃梻鍌欑閹碱偊寮甸鍕剮妞ゆ牜鍋熷畵浣规叏濡炶浜鹃梺鐟扮－婵敻鏁嶉幇顑芥斀闁糕剝蓱濮ｅ姊婚崒姘偓鐑芥嚄閸洍鈧箓宕奸妷顔芥櫈闂佺硶鍓濈粙鎴犵不娴煎瓨鐓欓梻鍌氼嚟椤︼箓鏌ｉ幘顖楀亾閹颁胶鍞甸梺鍏兼倐濞佳勬叏閸モ晝纾奸柍褜鍓熷畷姗€顢旀担闀愬闂佽崵鍠愬姗€藟韫囨稒鐓曢柣妯诲墯濞堟粎鈧娲樺姗€锝炲鍫濈劦妞ゆ巻鍋撴い顐㈢箳缁辨帒螣鐠囧樊鈧捇姊洪崗闂磋埅闁稿寒鍨堕崺鈧い鎺嗗亾闁哥喐鎸冲濠氭晲婢跺﹦顔婇梺缁樺姉閺佹悂寮抽妶鍛傛棃鎮╅棃娑楁勃闂佹悶鍔岄悘婵嬫偩閻戣棄绠氶梺顓ㄩ檮闉嬮梻鍌欑閹碱偄螞閹绢喗鈷旈柛鏇ㄥ灠缁犵偤鏌曟繛鍨姶婵炵鍔戦弻娑㈠焺閸愮偓鐣舵繝娈垮櫙缁犳挸顫忓ú顏勪紶闁告洦鍋呭▓顓㈡⒑缂佹﹩娈旀俊顐ｇ〒閸掓帡宕奸埗鈺佷壕闁挎繂楠搁弸鐔兼煟閹惧啿鏆ｉ柟顔煎槻閳诲氦绠涢幙鍐ф偅闂備礁鎲￠弻锝夊磹閺囥垺绠掓繝鐢靛Т閿曘倝鎮ц箛娑欏仼婵炲樊浜濋悡娑㈡倶閻愭彃鈷旀繛鎻掔摠椤ㄣ儵鎮欓崣澶婃灎濠碘槅鍋勯崯顐﹀煡婢跺ň鏋庨柟瀛樼矋閸犳岸姊婚崒姘偓椋庣矆娓氣偓楠炴牠顢曢敃鈧粻顖炴倵閿濆骸鏋涚紒鈧崼銉︾厽闁哄啫鍊哥敮鍫曟煢閸愵亜鏋戠紒缁樼洴楠炲鈻庤箛鏇炲Ф闂備浇妗ㄧ粈渚€宕幘顔艰摕闁靛鍎弨浠嬫煕閳╁厾顏嗙玻濞戙垺鈷戝ù鍏肩懅缁夘剟鏌涚€ｎ偄濮夋俊鍙夊姍楠炴鈧稒锚椤庢捇姊洪崨濠勭畵閻庢艾鎳橀弫鎰緞鐎ｎ剙骞堥梻渚€娼ц噹闁告洦鍓氶惁鎾绘⒒娴ｅ搫浠洪柛搴㈠絻铻為柛鎰╁妿閺嗭附鎱ㄥ璇蹭壕濡炪們鍨洪悷鈺佺暦閸欏鐝舵い鏍ㄧ婢跺嫰鏌ｉ幘瀛樼闁靛洤瀚伴獮鍥濞戞鐩庡┑鐐茬摠缁秶鍒掑鍥ㄥ床婵炴垯鍨归柋鍥ㄣ亜閹扳晛鐏╃紒鐘茬秺濮婅櫣鈧湱濯鎰版煕閵娿儲鍋ユ鐐插暣閸╋繝宕担瑙勬珖婵＄偑鍊ら崑鎺楀储婵傛潌?/students/:studentId 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌熼梻瀵割槮缁炬儳顭烽弻锝夊箛椤掍焦鍎撻梺鎼炲妼閸婂潡寮诲☉銏╂晝闁挎繂妫涢ˇ銉╂⒑閽樺鏆熼柛鐘崇墵瀵寮撮悢铏诡啎闂佺粯鍔﹂崜姘舵偟閿曞倹鈷戦弶鐐村椤︼箓鎮楀顐㈠祮鐎殿喛顕ч埥澶娢熼柨瀣垫綌闂備礁鎲￠〃鍫ュ磻閻愮儤鍊剁€广儱鎳夐弨浠嬫煟閹邦剙绾ч柛锝堟閳规垿鎮欓埡浣峰闂傚倷绀侀幖顐︽儗婢跺苯绶ら柛濠勫枔娴滅晫绱撴担鍝勪壕濠殿垵濮ら妵鏃傜矙閸熷啯甯掗悾婵嬪礋椤戣姤瀚肩紓鍌欑椤戝棝顢栧▎鎾崇？闁规壆澧楅悡娆撴煙闂傜鍏岄柣锝囧劋椤ㄣ儵鎮欏顔解枅濡ょ姷鍋為敃銏ゃ€佸▎鎾村殐闁冲搫锕ユ晥婵犵绱曢崑鎴﹀磹閺嶎厼绠伴柣鎰靛墯閸欏繒鐥幆褜鍎嶅ù婊冪秺楠炴牗娼忛崜褎鍋х紒鎯у綖缁瑩寮诲☉姘勃闁告挆鍕珯闂備胶顭堢换鎰版嚐椤栫偛鐓橀柟杈惧瘜閺佸﹪鏌熼鍡楀暙缁狅綁鏌ｆ惔銈庢綈婵炲弶鍨垮畷锟犲礃瀹割喖娈ㄦ繛瀵稿Т椤戞劙寮崶顒佺厽闁归偊鍓﹂崵鐔兼煃?
router.get('/mailbox', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(
      `SELECT sm.id, sm.student_id, sm.category, sm.content, sm.anonymous,
              CASE WHEN sm.status IN ('replied', 'closed') THEN 'resolved' ELSE 'pending' END AS status,
              sm.status AS raw_status,
              sm.reply_text AS reply,
              sm.created_at, sm.replied_at AS handled_at,
              CASE WHEN sm.anonymous = 1 THEN '????' ELSE s.name END AS student_name,
              s.name AS real_student_name,
              s.phone AS student_phone,
              t.name AS handled_by_name
       FROM student_mailbox_messages sm
       JOIN students s ON s.id = sm.student_id
       JOIN teacher_students ts ON ts.student_id = sm.student_id AND ts.teacher_id = ?
       LEFT JOIN teachers t ON t.id = sm.replied_by
       ORDER BY FIELD(sm.status, 'pending', 'read', 'replied', 'closed'), sm.created_at DESC, sm.id DESC`,
      [teacherId]
    )

    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put('/mailbox/:id', async (req, res) => {
  const teacherId = req.user.id
  const nextStatus = req.body.status === 'resolved' ? 'replied' : 'pending'
  const reply = String(req.body.reply || '').trim()

  try {
    const [[current]] = await pool.query(
      `SELECT id, student_id, category, status
       FROM student_mailbox_messages sm
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM teacher_students ts
           WHERE ts.teacher_id = ? AND ts.student_id = sm.student_id
         )
       LIMIT 1`,
      [req.params.id, teacherId],
    )

    if (!current) {
      return res.status(404).json({ message: '????' })
    }

    await pool.query(
      `UPDATE student_mailbox_messages
       SET status = ?, reply_text = ?, replied_by = ?, replied_at = ?
       WHERE id = ?`,
      [nextStatus, reply || null, teacherId, nextStatus === 'replied' ? new Date() : null, req.params.id],
    )

    if (current.status !== 'replied' && nextStatus === 'replied') {
      const categoryLabel = String(current.category || '??').trim() || '??'
      await pool.query(
        `INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at)
         VALUES (?, 'system', ?, ?, 'mailbox', ?, NOW())`,
        [
          current.student_id,
          `${categoryLabel}????`,
          reply || `??${categoryLabel}???????`,
          String(current.id),
        ],
      )
    }

    res.json({ message: nextStatus === 'replied' ? '?????' : '???????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/students/abnormal', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.name, s.status, sf.reason, sf.severity, sf.updated_at
       FROM student_flags sf
       JOIN students s ON sf.student_id = s.id
       JOIN teacher_students ts ON ts.student_id = sf.student_id AND ts.teacher_id = sf.teacher_id
       WHERE sf.teacher_id = ? AND sf.flagged = 1
       ORDER BY FIELD(sf.severity,'high','medium','low'), sf.updated_at DESC`,
      [teacherId]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾圭€瑰嫭鍣磋ぐ鎺戠倞妞ゆ帒顦伴弲顏堟偡濠婂啰绠婚柛鈹惧亾濡炪倖甯婇懗鍫曞煝閹剧粯鐓涢柛娑卞灠瀛濋梺浼欑到閸㈣尪鐏掗梺鍏肩ゴ閺呮繈鏁嶅鍐ｆ斀闁宠棄妫楅悘鐘崇節閳ь剚娼忛埡鍐х瑝濠殿喗顭堥崺鏍煕閹达附鐓欓柤娴嬫櫅娴犳粓鏌涢弮鈧幐鎶藉蓟濞戙垹绠婚悗闈涙啞閸ｄ即鎮楀▓鍨灈闁硅绱曠划顓㈡偄閻撳海鍔﹀銈嗗笒鐎氼剟鎷戦悢鍏肩厽闁哄啫鍊哥敮鍓佺磼閻樺磭鍙€闁哄瞼鍠愮€佃偐鈧稒蓱闁款厼鈹戦悙鑼⒈闁告ê澧藉Σ鎰板箻鐎涙ê顎撻梺鍦帛鐢﹥绔熼弴銏♀拻濞达綀娅ｉ妴濠囨煕閹惧绠樻繝鈧担铏圭＝濞达絿鐡旈崵娆愪繆椤愶絿绠炵€殿喖顭峰鎾閻樿鏁规繝鐢靛█濞佳兠洪妶鍛瀺闁挎繂鎷嬪〒濠氭煏閸繃鍣界紒鐘靛仱閺屾稒鎯旈敐鍡樻瘓閻?
router.get('/students', async (req, res) => {
  const teacherId = req.user.id
  try {
    const [rows] = await pool.query(`
      SELECT s.id,
             s.name,
             s.status,
             COALESCE(
               MAX(ts_self.subject),
               SUBSTRING_INDEX(GROUP_CONCAT(ts_all.subject ORDER BY ts_all.created_at DESC, ts_all.id DESC SEPARATOR '\n'), '\n', 1),
               ''
             ) AS subject,
             COALESCE(
               NULLIF(sp.grade, ''),
               MAX(ts_self.grade),
               SUBSTRING_INDEX(GROUP_CONCAT(ts_all.grade ORDER BY ts_all.created_at DESC, ts_all.id DESC SEPARATOR '\n'), '\n', 1),
               ''
             ) AS grade,
             MAX(ce.date) AS last_session_date
      FROM students s
      LEFT JOIN student_profiles sp ON sp.student_id = s.id
      LEFT JOIN teacher_students ts_self ON ts_self.student_id = s.id AND ts_self.teacher_id = ?
      LEFT JOIN teacher_students ts_all ON ts_all.student_id = s.id
      LEFT JOIN calendar_events ce ON ce.teacher_id = ? AND ce.student_id = s.id
      GROUP BY s.id, s.name, s.status, sp.grade, s.created_at
      ORDER BY FIELD(s.status, 'new', 'normal', 'abnormal', 'leave'), s.created_at DESC, s.id DESC
    `, [teacherId, teacherId])
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾圭€瑰嫭鍣磋ぐ鎺戠倞妞ゆ帒顦伴弲顏堟偡濠婂啰绠婚柛鈹惧亾濡炪倖甯婇懗鍫曞煝閹剧粯鐓涢柛娑卞灠瀛濋梺浼欑到閸㈣尪鐏掗梺鍏肩ゴ閺呮繈鏁嶅鍐ｆ斀闁宠棄妫楅悘鐘崇節閳ь剚娼忛埡鍐х瑝濠殿喗顭堥崺鏍煕閹达附鐓欓柤娴嬫櫅娴犳粓鏌涢弮鈧幐鎶藉蓟濞戙垹绠婚悗闈涙啞閸ｄ即鎮楀▓鍨灈闁硅绱曠划顓㈡偄閻撳海鍔﹀銈嗗笒鐎氼剟鎷戦悢鍏肩厽闁哄倸鐏濋幃鎴︽煕婵犲洦鏁遍柕鍥у楠炴帒顓奸崼婵嗗腐缂傚倷绀侀鍛洪妸褎顫曢柟鎯х摠婵绱掔€ｎ偒鍎ラ柡鍡愬灲濮婅櫣绮欏▎鎯у壄闂佺锕ョ换鍌烆敋閿濆洦瀚氭繛鏉戭儐椤秹姊洪棃娑氱濠殿喖鐗撴俊鎼佸煛閸屾粌寮虫繝鐢靛█濞佳兾涘▎鎾抽棷閻熸瑥瀚ㄦ禍婊勩亜閹哄棗浜惧銈忕畵濞佳囷綖韫囨拋娲敂閸曨亞鐐婇梻浣告啞濞诧箓宕滈敃鈧灋闁绘劗鍎ら埛鎴犵磽娴ｇ櫢渚涙繛鍫熸礋閺岀喖鎮烽悧鍫熸倷濡炪倖娲╃徊鍧楀箯閻樿鍦偓锝庡亽濞兼梹绻濆▓鍨灍妞ゃ劌鎳庤灋婵炴垯鍨归惌妤呮煕閳╁啰鈯曢柍閿嬪灴閺屾稑鈽夊鍫濅紣婵犳鍠掗崑鎾绘⒒娴ｅ憡鎯堥柟鍐茬箳閸掓帡骞橀懡銈呯ウ闂婎偄娲︾粙鎺楁倿閼测斁鍋撻獮鍨姎婵☆偄鐭傞獮蹇涙惞閸︻厾锛濋梺绋挎湰閻熝囧礉瀹ュ棎浜滄い鎾跺仦婢跺嫮绱掗弮鍌氭灈鐎规洜鍠栭、姗€鎮╃喊澶屽簥闂傚倷绀佸﹢杈╁垝椤栨粍鏆滄俊銈呮噹绾惧鏌曟径娑樼槣婵炲牅绮欓弻锝夊箛椤栨氨姣㈢紓浣哄У婵炲﹪寮诲鍫闂佸憡鎸堕崝搴ｆ閻愬搫骞㈡繛鎴烆焽椤︻厼鈹戦绛嬬劸婵炲绋戞晥闁告瑥顦辩弧鈧繝鐢靛Т閸婃悂顢旈妷銉冪懓顭ㄩ崟顓犵厜闂佸搫鐭夌换婵嗙暦閹烘埈娼╅柛娆愵焾濡炬悂姊绘担鐟扳枙闁衡偓閸楃儐娼栫憸鐗堝笒妗呴梺鍛婃处閸ㄩ亶寮插鍫熷仭婵炲棗绻愰顏堟煟濠靛洩澹橀柍瑙勫灴椤㈡瑧娑甸柨瀣毎婵犵绱曢崑鐘参涢崟顖涘仼闁绘垼妫勬儫闂佹寧鏌ㄦ晶浠嬫儊閸儲鈷戠紒瀣濠€鎵棯閺夎法效闁诡垯绶氶獮妯肩磼濡攱瀚藉┑鐐舵彧缁茶偐鎷冮敃鍌涘€块柣鎰靛厵娴滄粓鏌熺€涙绠栭柛銈呮喘閹稿﹤鈹戠€ｎ偆鍘介梺闈涚箚閸撴繈宕戦悩缁樼厓鐟滄粓宕楀☉姘辩焼濞撴埃鍋撻柨婵堝仜閳规垹鈧絽鐏氶弲銏ゆ⒑缁嬫寧婀扮紒瀣浮椤㈡瑩寮撮姀鈾€鎷绘繛杈剧秬椤宕戦悩缁樼厱閹兼惌鍠栧▍宥団偓娈垮枟瑜板啴鍩為幋鐘亾閿濆骸浜滃ù婊勵殜濮婃椽鎮烽弶搴撴寖缂備緡鍣崹鍫曞箖閿熺姵鍋勯柣鎾虫捣椤旀劙姊洪崷顓涙嫛闁告ê銈搁幃姗€鏁愰崶鈺冿紲婵犮垼娉涢張顒勫汲椤掑嫭鐓涢悘鐐插⒔閳藉鎽堕敐澶嬬厱婵犻潧妫楅銈夋煙缁嬪灝鏆熺紒杈ㄦ尰缁楃喖宕惰閻忔挾绱撴笟鍥ф珮闁搞劍濞婇獮鎴﹀閻橆偅鏂€闂佺硶妾ч弲婊堝磽闂堟侗娓婚柕鍫濇缁楁帡鏌涚€ｎ亝顥㈢€规洦鍨跺畷鍫曨敆娴ｅ弶瀚奸梻浣告啞缁诲倻鈧艾鍢插嵄闁归棿鐒﹂悡鐔镐繆閵堝倸浜鹃梺鎸庢磸閸婃繈骞冮幆褏鏆嬮梺顓ㄩ檮瀵ゆ椽姊洪柅鐐茶嫰婢ф挳鏌曢崱鏇狀槮妞ゎ偅绮撻崺鈧い鎺戝缁犲湱鎲搁悧鍫濈瑨闁圭鍩栭妵鍕箻鐠轰警鈧挾绱?
router.get('/complaints', async (req, res) => {
  const teacherId = req.user.id
  const { studentId } = req.query

  try {
    let sql = `SELECT sc.*, s.name AS student_name, t.name AS submitted_by_name
               FROM student_complaints sc
               JOIN students s ON s.id = sc.student_id
               JOIN teachers t ON t.id = sc.created_by_teacher_id
               WHERE sc.created_by_teacher_id = ?`
    const params = [teacherId]

    if (studentId) {
      sql += ' AND sc.student_id = ?'
      params.push(studentId)
    }

    sql += ' ORDER BY sc.created_at DESC'
    const [rows] = await pool.query(sql, params)
    res.json(rows.map(mapComplaintRow))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.post('/complaints', async (req, res) => {
  const teacherId = req.user.id
  const {
    studentId,
    demand,
    reason,
    suggestion,
    resolvers,
    deadline,
    extraNote = '',
    attachments = [],
    submittedBy,
  } = req.body

  if (!studentId || !String(demand || '').trim() || !String(reason || '').trim() || !String(suggestion || '').trim() || !Array.isArray(resolvers) || resolvers.length === 0 || !deadline) {
    return res.status(400).json({ message: '????' })
  }

  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(404).json({ message: '????' })

    const [result] = await pool.query(
      `INSERT INTO student_complaints (
        student_id, created_by_teacher_id, demand, reason, suggestion,
        resolvers_json, deadline, extra_note, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(studentId),
        teacherId,
        String(demand).trim(),
        String(reason).trim(),
        String(suggestion).trim(),
        JSON.stringify(resolvers),
        deadline,
        String(extraNote || '').trim(),
        JSON.stringify(Array.isArray(attachments) ? attachments : []),
      ]
    )

    const [[row]] = await pool.query(
      `SELECT sc.*, s.name AS student_name, ? AS submitted_by_name
       FROM student_complaints sc
       JOIN students s ON s.id = sc.student_id
       WHERE sc.id = ?
       LIMIT 1`,
      [submittedBy || req.user.name || '', result.insertId]
    )

    await pool.query(
      `INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at)
       VALUES (?, 'system', ?, ?, 'complaint', ?, NOW())`,
      [
        Number(studentId),
        '\u6295\u8bc9\u5df2\u63d0\u4ea4',
        String(reason).slice(0, 120),
        String(result.insertId),
      ]
    )

    res.status(201).json(mapComplaintRow(row))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put('/complaints/:id/resolve', async (req, res) => {
  const teacherId = req.user.id
  const resolvedNote = String(req.body.resolvedNote || '').trim()
  const complaintId = Number(req.params.id)

  if (!complaintId) return res.status(400).json({ message: '????' })

  try {
    const [result] = await pool.query(
      `UPDATE student_complaints
       SET status = 'resolved', resolved_note = ?, resolved_at = NOW()
       WHERE id = ? AND created_by_teacher_id = ?`,
      [resolvedNote || null, complaintId, teacherId]
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '????' })
    }

    const [[row]] = await pool.query(
      `SELECT sc.*, s.name AS student_name, t.name AS submitted_by_name
       FROM student_complaints sc
       JOIN students s ON s.id = sc.student_id
       JOIN teachers t ON t.id = sc.created_by_teacher_id
       WHERE sc.id = ?
       LIMIT 1`,
      [complaintId]
    )

    await pool.query(
      `INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at)
       VALUES (?, 'system', ?, ?, 'complaint', ?, NOW())`,
      [
        Number(row.student_id),
        '\u6295\u8bc9\u5df2\u5904\u7406',
        resolvedNote || '\u60a8\u7684\u6295\u8bc9\u5df2\u5904\u7406',
        String(complaintId),
      ]
    )

    res.json(mapComplaintRow(row))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function clampNumber(value, min, max) {
  const numberValue = toNullableNumber(value)
  if (numberValue === null) return null
  return Math.max(min, Math.min(max, Math.round(numberValue)))
}

function scoreGap(targetScore, diagnosisScore) {
  if (targetScore === null || targetScore === undefined || diagnosisScore === null || diagnosisScore === undefined) return null
  return Number(targetScore) - Number(diagnosisScore)
}

function isMissingTableError(error) {
  return error && error.code === 'ER_NO_SUCH_TABLE'
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

async function getReviewPointStatusesForStudent(studentId) {
  const [courseRows] = await pool.query(
    `SELECT c.name AS pointName, sc.status
     FROM student_courses sc
     JOIN courses c ON c.id = sc.course_id
     WHERE sc.student_id = ?`,
    [studentId]
  )

  const [learningPathRows] = await pool.query(
    `SELECT DISTINCT point_name AS pointName
     FROM student_learning_path_tasks
     WHERE student_id = ?
       AND point_name IS NOT NULL
       AND point_name != ''`,
    [studentId]
  )

  return buildReviewPointStatuses({
    courseRows,
    learningPathRows,
    pendingStatus: 'pending',
  }).map((entry) => ({
    pointId: entry.id,
    pointName: entry.pointName,
    status: entry.status,
  }))
}

function getStartOfLocalDay(date = new Date()) {
  const current = new Date(date)
  current.setHours(0, 0, 0, 0)
  return current
}

function getStartOfWeek(date = new Date()) {
  const current = getStartOfLocalDay(date)
  const day = current.getDay() || 7
  current.setDate(current.getDate() - day + 1)
  return current
}

function getStartOfMonth(date = new Date()) {
  const current = getStartOfLocalDay(date)
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

function parseValidDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function toIsoDateTime(value) {
  const date = parseValidDate(value)
  return date ? date.toISOString() : ''
}

function getLocalDayKey(date) {
  return formatDateKey(getStartOfLocalDay(date))
}

function buildDayBuckets(now = new Date(), count = 7) {
  const start = getStartOfWeek(now)
  const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

  return Array.from({ length: count }, (_, index) => {
    const date = addDays(start, index)
    return {
      key: `day${index + 1}`,
      bucketKey: formatDateKey(date),
      label: labels[index] || `第${index + 1}天`,
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
      label: `第${index + 1}周`,
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
      label: `${date.getMonth() + 1}月`,
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
    if (!isMissingTableError(error)) throw error
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
    if (!isMissingTableError(error)) throw error
  }

  const sessionTotals = {
    day: {},
    week: {},
    month: {},
  }

  sessionRows.forEach((row) => {
    const startedAt = parseValidDate(row.started_at)
    if (!startedAt) return

    const rawDuration = Number(row.duration_sec || 0)
    const endedAt = parseValidDate(row.ended_at)
    const durationSec = rawDuration > 0
      ? rawDuration
      : endedAt
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

function getLateSessionScore(date) {
  const hours = date.getHours() + (date.getMinutes() / 60)
  return hours < 5 ? hours + 24 : hours
}

async function ensureTeacherCanAccessStudent(_teacherId, studentId) {
  const [[row]] = await pool.query(
    'SELECT 1 AS ok FROM students WHERE id = ? LIMIT 1',
    [studentId]
  )
  return Boolean(row)
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
  return buildLearningPathPayload(studentId, safePointName, rows.map((row) => ({
    ...row,
    status: Number(row.is_done) ? 'done' : 'pending',
  })))
}

async function syncStudentCourseProgress(executor, studentId, pointName) {
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

  await rebalanceStudentCourseStatuses(executor, studentId)

  return {
    progress: summary.progressPercent,
    status: courseStatus,
  }
}

async function syncAllStudentCourseProgress(executor, studentId) {
  const [rows] = await executor.query(
    `SELECT DISTINCT point_name
     FROM student_learning_path_tasks
     WHERE student_id = ?
       AND point_name IS NOT NULL
       AND point_name != ''`,
    [studentId]
  )

  for (const row of rows) {
    await syncStudentCourseProgress(executor, studentId, row.point_name)
  }

  await rebalanceStudentCourseStatuses(executor, studentId)
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
  executor = pool,
}) {
  const safePointName = normalizeCheckpointName(pointName)
  let lastError = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [[existingRow]] = await executor.query(
        `SELECT id, meta_json
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

      await executor.query(
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

      await syncStudentCourseProgress(executor, studentId, safePointName)

      return {
        pointName: safePointName,
        taskId,
        stageKey,
        status: nextDone ? 'done' : 'pending',
        updatedAt: new Date().toISOString(),
      }
    } catch (error) {
      lastError = error
      const retryable = error && (
        error.code === 'ER_LOCK_WAIT_TIMEOUT'
        || error.code === 'ER_LOCK_DEADLOCK'
        || error.errno === 1205
        || error.errno === 1213
      )
      if (!retryable || attempt >= 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)))
    }
  }

  throw lastError
}

async function getPointLearningSummary(studentId, pointName) {
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
    const startedAt = parseValidDate(row.started_at)
    if (!startedAt) return

    const endedAt = parseValidDate(row.ended_at)
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
        startedAt: toIsoDateTime(startedAt),
        clock: startClock,
      }
    }

    const sessionEnd = endedAt || new Date(startedAt.getTime() + durationSec * 1000)
    const lateScore = getLateSessionScore(sessionEnd)
    if (!latestSession || lateScore > latestSession.score) {
      latestSession = {
        date: dayKey,
        endedAt: toIsoDateTime(sessionEnd),
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

  return {
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
  }
}

async function getReviewOverviewForStudent(studentId) {
  await syncAllStudentCourseProgress(pool, studentId)

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
    pointRates = rows.map((row) => ({
      ...row,
      pointName: normalizeCheckpointName(row.pointName),
    }))
  } catch (error) {
    if (!isMissingTableError(error)) throw error
  }

  const studyTimes = await buildStudyTimesFromSessions(studentId)

  const pointStatuses = await getReviewPointStatusesForStudent(studentId)

  return {
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
  }
}

async function saveReviewProgress(conn, teacherId, studentId, progress, targetExamValue) {
  const hasProgressPayload = !!(progress && typeof progress === 'object')
  const targetExam = typeof targetExamValue === 'string' ? targetExamValue.trim() : null
  if (!hasProgressPayload && targetExam === null) return

  const entryScore = hasProgressPayload ? clampNumber(progress.entryScore, 0, 150) : null
  const currentScore = hasProgressPayload ? clampNumber(progress.currentScore, 0, 150) : null
  const targetScore = hasProgressPayload ? clampNumber(progress.targetScore, 0, 150) : null
  const effectiveCurrentScore = currentScore ?? entryScore

  if (entryScore === null && currentScore === null && targetScore === null && targetExam === null) return

  const [[firstDiagnosis]] = await conn.query(
    `SELECT id, target_exam, diagnosis_score, target_score
     FROM diagnosis_reports
     WHERE student_id = ?
     ORDER BY COALESCE(diagnosis_date, created_at) ASC, id ASC
     LIMIT 1`,
    [studentId]
  )
  const [[latestDiagnosis]] = await conn.query(
    `SELECT id, target_exam, diagnosis_score, target_score
     FROM diagnosis_reports
     WHERE student_id = ?
     ORDER BY COALESCE(diagnosis_date, created_at) DESC, id DESC
     LIMIT 1`,
    [studentId]
  )

  if (firstDiagnosis) {
    const nextEntryScore = entryScore ?? firstDiagnosis.diagnosis_score
    const nextEntryTarget = targetScore ?? firstDiagnosis.target_score
    const nextEntryExam = targetExam === null ? firstDiagnosis.target_exam : targetExam
    await conn.query(
      `UPDATE diagnosis_reports
       SET teacher_id = ?, target_exam = ?, diagnosis_score = ?, target_score = ?, score_gap = ?, diagnosis_date = COALESCE(diagnosis_date, CURDATE())
       WHERE id = ?`,
      [teacherId, nextEntryExam, nextEntryScore, nextEntryTarget, scoreGap(nextEntryTarget, nextEntryScore), firstDiagnosis.id]
    )
  } else {
    await conn.query(
      `INSERT INTO diagnosis_reports (student_id, teacher_id, target_exam, target_score, diagnosis_score, score_gap, diagnosis_date)
       VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
      [studentId, teacherId, targetExam, targetScore, entryScore ?? effectiveCurrentScore, scoreGap(targetScore, entryScore ?? effectiveCurrentScore)]
    )
  }

  if (effectiveCurrentScore === null) return

  const [[firstAfterSave]] = await conn.query(
    `SELECT id, target_exam, diagnosis_score, target_score
     FROM diagnosis_reports
     WHERE student_id = ?
     ORDER BY COALESCE(diagnosis_date, created_at) ASC, id ASC
     LIMIT 1`,
    [studentId]
  )
  const [[latestAfterSave]] = await conn.query(
    `SELECT id, target_exam, diagnosis_score, target_score
     FROM diagnosis_reports
     WHERE student_id = ?
     ORDER BY COALESCE(diagnosis_date, created_at) DESC, id DESC
     LIMIT 1`,
    [studentId]
  )

  if (latestAfterSave && firstAfterSave && latestAfterSave.id !== firstAfterSave.id) {
    const nextTarget = targetScore ?? latestAfterSave.target_score
    const nextExam = targetExam === null ? latestAfterSave.target_exam : targetExam
    await conn.query(
      `UPDATE diagnosis_reports
       SET teacher_id = ?, target_exam = ?, diagnosis_score = ?, target_score = ?, score_gap = ?, diagnosis_date = CURDATE()
       WHERE id = ?`,
      [teacherId, nextExam, effectiveCurrentScore, nextTarget, scoreGap(nextTarget, effectiveCurrentScore), latestAfterSave.id]
    )
  } else if (firstAfterSave && Number(effectiveCurrentScore) !== Number(firstAfterSave.diagnosis_score)) {
    const nextTarget = targetScore ?? firstAfterSave.target_score
    const nextExam = targetExam === null ? firstAfterSave.target_exam : targetExam
    await conn.query(
      `INSERT INTO diagnosis_reports (student_id, teacher_id, target_exam, target_score, diagnosis_score, score_gap, diagnosis_date)
       VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
      [studentId, teacherId, nextExam, nextTarget, effectiveCurrentScore, scoreGap(nextTarget, effectiveCurrentScore)]
    )
  }
}

async function replaceReviewPointScores(conn, studentId, pointRates) {
  if (!Array.isArray(pointRates)) return

  await conn.query('DELETE FROM review_point_scores WHERE student_id = ?', [studentId])
  for (const [index, item] of pointRates.entries()) {
    const pointName = String(item.pointName ?? item.point_name ?? '').trim()
    if (!pointName) continue
    const currentRate = clampNumber(item.currentRate ?? item.current_rate, 0, 100)
    const targetRate = clampNumber(item.targetRate ?? item.target_rate, 0, 100)
    const sourceType = item.sourceType === 'monthly_review' ? 'monthly_review' : 'diagnosis'
    await conn.query(
      `INSERT INTO review_point_scores (student_id, point_name, current_rate, target_rate, source_type, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentId, pointName, currentRate, targetRate, sourceType, index + 1]
    )
  }
}

async function replaceStudyTimeStats(conn, studentId, studyTimes) {
  if (!Array.isArray(studyTimes)) return

  await conn.query('DELETE FROM study_time_stats WHERE student_id = ?', [studentId])
  for (const [index, item] of studyTimes.entries()) {
    const periodLabel = String(item.label ?? item.periodLabel ?? item.period_label ?? '').trim()
    if (!periodLabel) continue
    const periodKey = String(item.key ?? item.periodKey ?? item.period_key ?? `period_${index + 1}`).trim() || `period_${index + 1}`
    const hours = toNullableNumber(item.hours) ?? 0
    const cycleType = item.cycleType === 'month' ? 'month' : 'week'
    await conn.query(
      `INSERT INTO study_time_stats (student_id, period_key, period_label, hours, cycle_type, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentId, periodKey, periodLabel, Math.max(0, hours), cycleType, index + 1]
    )
  }
}

router.get('/students/:studentId/review-overview', async (req, res) => {
  const teacherId = req.user.id
  const studentId = Number(req.params.studentId)

  if (!studentId) return res.status(400).json({ message: '????' })

  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(403).json({ message: '????' })

    res.json(await getReviewOverviewForStudent(studentId))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/students/:studentId/point-learning-summary', async (req, res) => {
  const teacherId = req.user.id
  const studentId = Number(req.params.studentId)
  const pointName = String(req.query.pointName || '').trim()

  if (!studentId) return res.status(400).json({ message: '????' })
  if (!pointName) return res.status(400).json({ message: '????' })

  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(403).json({ message: '????' })

    res.json(await getPointLearningSummary(studentId, pointName))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/students/:studentId/learning-path', async (req, res) => {
  const teacherId = req.user.id
  const studentId = Number(req.params.studentId)
  const pointName = String(req.query.pointName || '').trim()

  if (!studentId) return res.status(400).json({ message: '????' })
  if (!pointName) return res.status(400).json({ message: '????' })

  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(403).json({ message: '????' })

    res.json(await buildStudentLearningPath(studentId, pointName))
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.patch('/students/:studentId/learning-path/tasks/:taskId', async (req, res) => {
  const teacherId = req.user.id
  const studentId = Number(req.params.studentId)
  const taskId = String(req.params.taskId || '').trim()
  const pointName = String(req.body.pointName || '').trim()
  const stageKey = String(req.body.stageKey || '').trim()

  if (!studentId) return res.status(400).json({ message: '????' })
  if (!taskId) return res.status(400).json({ message: '????' })
  if (!pointName) return res.status(400).json({ message: '????' })
  if (!stageKey) return res.status(400).json({ message: '????' })

  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(403).json({ message: '????' })

    const safePointName = normalizeCheckpointName(pointName)
    const learningPathRows = await loadLearningPathRows(studentId, safePointName)
    const taskDefinition = findTaskDefinition(stageKey, taskId, learningPathRows)
    if (!taskDefinition) {
      return res.status(400).json({ message: '????' })
    }

    const resourcePatch = req.body.resource || undefined
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
      resource: resourcePatch,
      uploads: req.body.uploads,
    }
    // ResourceEditor 로 live/replay 링크를 저장할 때 meta.liveUrl/replayUrl 도 동기화
    if (resourcePatch && resourcePatch.liveUrl)   metaPatch.liveUrl   = resourcePatch.liveUrl
    if (resourcePatch && resourcePatch.replayUrl) metaPatch.replayUrl = resourcePatch.replayUrl

    const payload = await saveLearningPathTask({
      studentId,
      pointName,
      stageKey,
      taskId,
      status: String(req.body.status || 'done').trim() || 'done',
      metaPatch,
      actorRole: 'teacher',
      actorId: teacherId,
    })

    res.json({ ok: true, ...payload })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.put('/students/:studentId/review-overview', async (req, res) => {
  const teacherId = req.user.id
  const studentId = Number(req.params.studentId)

  if (!studentId) return res.status(400).json({ message: '????' })

  let conn
  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(403).json({ message: '????' })

    conn = await pool.getConnection()
    await conn.beginTransaction()

    await saveReviewProgress(conn, teacherId, studentId, req.body.progress, req.body.targetExam)
    await replaceReviewPointScores(conn, studentId, req.body.pointRates)
    await replaceStudyTimeStats(conn, studentId, req.body.studyTimes)

    await conn.commit()
    res.json(await getReviewOverviewForStudent(studentId))
  } catch (err) {
    if (conn) await conn.rollback()
    res.status(500).json({ message: err.message })
  } finally {
    if (conn) conn.release()
  }
})
router.get('/students/:studentId/info', async (req, res) => {
  const { studentId } = req.params
  const teacherId = req.user.id
  try {
    await syncAllStudentCourseProgress(pool, Number(studentId))

    const [[student]] = await pool.query(
      `SELECT s.id, s.name, s.status, s.created_at,
              sp.gender, sp.grade AS profile_grade, sp.hometown, sp.exam_status, sp.exam_date,
              sp.education, sp.major, sp.avatar_url
       FROM students s
       LEFT JOIN student_profiles sp ON sp.student_id = s.id
       WHERE s.id = ?
       LIMIT 1`,
      [studentId]
    )
    if (!student) return res.status(404).json({ message: '????' })
    const [notes] = await pool.query(
      'SELECT * FROM student_notes WHERE teacher_id = ? AND student_id = ? ORDER BY created_at DESC',
      [teacherId, studentId]
    )
    const [[flag]] = await pool.query(
      'SELECT flagged, reason, severity FROM student_flags WHERE teacher_id = ? AND student_id = ?',
      [teacherId, studentId]
    )
    const [courses] = await pool.query(
      `SELECT sc.id, c.name, c.subject, sc.progress, sc.status, sc.sort_order AS sortOrder
       FROM student_courses sc JOIN courses c ON sc.course_id = c.id
       WHERE sc.student_id = ?
       ORDER BY sc.sort_order ASC, sc.id ASC`,
      [studentId]
    )
    const [[sessionStats]] = await pool.query(
      `SELECT COUNT(*) AS session_count,
              COALESCE(SUM(
                CASE
                  WHEN duration_sec IS NOT NULL AND duration_sec > 0
                  THEN duration_sec
                  WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                  THEN TIMESTAMPDIFF(SECOND, started_at, ended_at)
                  ELSE 0
                END
              ) / 3600, 0) AS total_hours
       FROM study_sessions
       WHERE student_id = ?
         AND started_at IS NOT NULL
         AND status IN ('started', 'completed')`,
      [studentId]
    )
    const [teamTeachers] = await pool.query(
      `SELECT t.id, t.name, t.title, stm.role, stm.status
       FROM student_team_members stm
       JOIN teachers t ON t.id = stm.teacher_id
       WHERE stm.student_id = ?
       ORDER BY FIELD(stm.role, 'coach', 'diagnosis', 'manager', 'principal'), t.id`,
      [studentId]
    )
    const [submissions] = await pool.query(
      `SELECT id, review_type, checkpoint, file_name, graded, score, feedback, graded_at, created_at
       FROM pdf_submissions
       WHERE student_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [studentId]
    )
    const [checkpointRows] = await pool.query(
      `SELECT DISTINCT point_name FROM student_learning_path_tasks
       WHERE student_id = ? AND point_name IS NOT NULL AND point_name != ''`,
      [studentId]
    )
    const [courseCheckpointRows] = await pool.query(
      `SELECT DISTINCT c.name AS point_name
       FROM student_courses sc
       JOIN courses c ON c.id = sc.course_id
       WHERE sc.student_id = ? AND c.name IS NOT NULL AND c.name != ''`,
      [studentId]
    )
    const activeCheckpoints = new Set([
      ...checkpointRows.map((r) => r.point_name),
      ...courseCheckpointRows.map((r) => normalizeCheckpointName(r.point_name)).filter(Boolean),
    ])
    const checkpoints = ALL_CHECKPOINTS.map((name) => ({
      name,
      hasData: activeCheckpoints.has(name),
    }))
    res.json({
      student: student ?? null,
      notes,
      flagged: flag?.flagged ?? false,
      flagReason: flag?.reason ?? null,
      flagSeverity: flag?.severity ?? null,
      courses: courses.map((course) => ({
        ...course,
        name: normalizeCheckpointName(course.name),
      })),
      checkpoints,
      sessionCount: Number(sessionStats?.session_count ?? 0),
      totalHours: Number(sessionStats?.total_hours ?? 0),
      teamTeachers,
      submissions: submissions.map((submission) => ({
        ...submission,
        checkpoint: normalizeCheckpointName(submission.checkpoint),
      })),
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 婵犵數濮烽弫鍛婃叏閻戣棄鏋侀柛娑橈攻閸欏繘鏌ｉ幋锝嗩棄闁哄绶氶弻鐔兼⒒鐎靛壊妲紒鐐劤濞硷繝寮婚悢琛″亾閻㈡鐒鹃崯鍝ョ磽娴ｆ彃浜炬繝鐢靛Т濞诧箓鎮￠崘顏呭枑婵犲﹤鐗嗙粈鍫熸叏濡寧纭惧鍛存⒑閸涘﹥澶勯柛銊ゅ嵆瀹曪繝骞庨懞銉у幈闂佹枼鏅涢崰姘枔閺冣偓閵囧嫯绠涢敐鍕仐闂佸搫鏈粙鎴﹀煝鎼淬倗鐤€闁哄洨濯崯瀣⒒娴ｅ憡鎯堥柣顓烆槺缁辩偞绗熼埀顒勬偘椤曗偓瀹曞爼顢楁径瀣珝闂備胶绮Λ浣糕枍閿濆鐓濋煫鍥ㄦ礈绾句粙鏌涚仦鍓ф噮妞わ讣绠戦…鑳槻闂佸府绲介悾鐑藉箣閿曗偓鍥存繝銏ｆ硾閿曘劑骞楅弴鐐╂斀闁绘劖娼欓悘鐔兼煕閵娧勫殌闁轰緡鍣ｅ缁樻媴閻熼偊鍤嬬紓浣筋嚙閸婂潡鐛繝鍐╁劅闁靛ň鎳囬崑鎾诲冀閵娿儳绐為梺褰掑亰閸樻悂骞?
router.post('/students/:studentId/notes', async (req, res) => {
  const { studentId } = req.params
  const { content } = req.body
  const teacherId = req.user.id
  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(404).json({ message: '????' })

    await pool.query(
      'INSERT INTO student_notes (teacher_id, student_id, content, author) VALUES (?, ?, ?, ?)',
      [teacherId, studentId, content, req.user.name]
    )
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾剧懓顪冪€ｎ亝鎹ｉ柣顓炴閵嗘帒顫濋敐鍛婵°倗濮烽崑娑⑺囬悽绋挎瀬鐎广儱顦粈瀣亜閹哄秶鍔嶆い鏂挎喘濮婄粯鎷呴搹鐟扮闂佸憡姊瑰ú鐔笺€佸棰濇晣闁绘ê鍚€缁楀淇婇妶蹇曞埌闁哥噥鍨堕幃锟犲礃椤忓懎鏋戝┑鐘诧工閻楀棛绮堥崼鐔稿弿婵☆垰娼￠崫铏光偓瑙勬礀瀵墎鎹㈠☉銏犵婵炲棗绻掓禒濂告倵閻熺増鍟炵紒璇插暣婵＄敻宕熼姘鳖啋闁荤姴鎼幖顐ｇ珶婢舵劖鈷戦柛娑橈攻閻撱儲銇勯敂鐐毈妤犵偛鍟灃闁告侗鍘奸悗顓烆渻閵堝棗濮х紒鎻掓健瀹曟瑩鏁撻悩宕囧幗闁瑰吋鐣崹濠氥€傞崣澶岀瘈闁靛繆妲勯懓鍧楁煙椤曗偓缁犳牠骞冨鍫熷癄濠㈣埖鍔曢弫褰掓⒒娴ｅ憡鎯堟繛灞傚姂瀹曟劙鏁愭径濠勫幐闂佸憡渚楅崰姘跺矗閸℃稒鈷戦柛婵嗗閺嗘瑦绻涚仦鍌氣偓娑€傞崸妤佲拻?
router.delete('/notes/:noteId', async (req, res) => {
  try {
    await pool.query('DELETE FROM student_notes WHERE id = ? AND teacher_id = ?',
      [req.params.noteId, req.user.id])
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾剧懓顪冪€ｎ亝鎹ｉ柣顓炴閵嗘帒顫濋敐鍛婵°倗濮烽崑鐐烘偋閻樻眹鈧線寮撮姀鐘栄囨煕閵夈垺娅囬柛妯煎█濮婄粯鎷呴崨濠冨創濡炪倧缂氶崡鍐茬暦闂堟侗娼╂い鎴犲仦濡炰粙銆侀弮鍫濈妞ゆ挾鍋涚粻浼存⒒閸屾瑧顦﹂柟璇х磿閸掓帡宕奸妷锕€鈧潡鏌ㄩ弴鐐测偓鎼佹偪妤ｅ啯鐓冮柛婵嗗閸ｆ椽鏌嶉柨瀣伌闁哄瞼鍠栭幊鏍煛娴ｉ鎹曢梻浣告啞閺岋繝宕戦幘缁樷拺閻犲洩灏欑粻鎶芥煕鐎ｎ剙校闁逛究鍔戞俊鑸靛緞濡粯娅嶉梻浣侯潒閸曞灚鐣烽梺鎶芥敱鐢帡婀侀梺鎸庣箓鐎氼垶顢楅悢鍏肩厽闁圭儤顨堥悾娲煛瀹€瀣瘈鐎规洖銈搁、鏇㈠閻欌偓濞肩粯淇婇悙顏勨偓銈夊磻閸涱垱宕查柛顐ゅ枍缁诲棝鏌熼梻瀵割槮闁绘挻绋戦湁闁挎繂鐗滃鎰偖閿濆應鏀介柣妯垮皺濡嫰鏌℃径濠勬皑闁稿鎹囧鎾閻樼數鏋冮梻濠庡亜濞诧妇绮欓幋鐘差棜鐟滅増甯楅悡鏇熴亜椤撶喎鐏ュù婊呭仧缁辨帡鎮╅懡銈囨毇闂佸搫鐬奸崰鎾诲焵椤掍胶鈯曟い顓炴川缁骞樼紒妯煎幐闂佺硶鍓濆畝鎼佸传濞差亝鐓忛柛銉戝喚浼冮梺绯曟杹閸撴繄鎹㈠┑瀣＜婵﹫绲剧€氼剟姊婚崒娆戭槮闁圭⒈鍋呭鍕炊椤掆偓缁€鍫熺節闂堟侗鍎忕紒鐙€鍨堕弻娑樷槈閸楃偟浠梺鍝ュТ濡繈寮诲☉銏犲嵆闁靛鍎扮花浠嬫⒑閹稿海鈯曢柟鐟版搐椤繒绱掑Ο璇差€撻梺鍏间航閸庮垶鍩€椤掆偓閸熸壆妲愰幒妤€鐒垫い鎺嶇劍婵挳鏌ц箛鎾磋础闁绘挸顑夊娲嚒閵堝懏鐎炬繝銏㈡嚀濡繂顕ｉ幎鑺ユ櫇闁逞屽墴閸╃偤骞嬮敃鈧壕鍏兼叏濮楀棗骞栭柡鍡楃墦濮婅櫣绮欏▎鎯у壈闁诲孩鐭崡鍐差嚕鐠囨祴妲堟俊顖炴敱椤秴鈹戦绛嬫當闁绘锕顐﹀箚瑜滃〒濠氭煏閸繃顥為柣鎾卞劜缁绘稑顔忛鐓庣濡?reason 闂?severity闂?
router.put('/students/:studentId/flag', async (req, res) => {
  const { flagged, reason, severity } = req.body
  const { studentId } = req.params
  const teacherId = req.user.id
  try {
    const canAccess = await ensureTeacherCanAccessStudent(teacherId, studentId)
    if (!canAccess) return res.status(404).json({ message: '????' })

    await pool.query(
      `INSERT INTO student_flags (teacher_id, student_id, flagged, reason, severity)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE flagged = ?, reason = ?, severity = ?, updated_at = NOW()`,
      [teacherId, studentId, flagged, reason || null, severity || 'medium',
       flagged, reason || null, severity || 'medium']
    )
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾剧懓顪冪€ｎ亝鎹ｉ柣顓炴閵嗘帒顫濋敐鍛婵°倗濮烽崑鐐烘偋閻樻眹鈧線寮撮姀鈩冩珖闂侀€炲苯澧撮柟顔兼健椤㈡岸鍩€椤掑嫬钃熼柡鍥╁枔缁犻箖鏌ｉ幇闈涘闁绘繃姊荤槐鎺楁倷椤掆偓閸斻倖绻涚涵椋庣瘈鐎殿喛顕ч埥澶娢熷鍕棃鐎规洘锕㈡俊鎼佸Ψ閵夘喗顥忛梻鍌氬€风粈渚€骞楀鍫濈獥閹兼番鍔岀粻鐘诲箹濞ｎ剙濡奸柣鎾达耿閺岀喐娼忔ィ鍐╊€嶉梺绋款儐閸旀瑩骞冨Δ鍛嵍妞ゆ挾鍊姀掳浜滈柕澶涘缁犳绱掓潏銊﹀鞍闁瑰嘲鎳橀獮鎾诲箳瀹ュ拋妫滈梻鍌氬€烽懗鍓佹兜閸洖绀堟繝闈涚墛缁犳帞绱撻崒娆愮グ妞ゆ泦鍏炬稑鈹戠€ｎ亣鎽曢梺鍝勬储閸ㄥ綊鏌嬮崶銊х瘈闂傚牊绋掗幖鎰箾閸滃啰鍒版い顏勫暣婵″爼宕ㄩ婊呮澖闂備胶顭堝ù鐑藉极鐠囧樊鍤?
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

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾剧懓顪冪€ｎ亝鎹ｉ柣顓炴閵嗘帒顫濋敐鍛婵°倗濮烽崑鐐烘偋閻樻眹鈧線寮撮姀鈩冩珖闂侀€炲苯澧板瑙勬礉閵囨劙骞掗幘璺哄箺闂備胶绮濠氬储瑜庣粋宥嗗鐎涙鍘介梺鍝勫€圭€笛囁夐悙鐑樼厵濞撴艾鐏濇俊鍏笺亜椤忓嫬鏆熼柟椋庡█閻擃偊顢橀悜鍡橆棥闂傚倷娴囧畷鍨叏瀹曞洦濯伴柨鏇炲€搁崹鍌炴煕椤愶絾绀€闁藉啰鍠愮换娑㈠箣濞嗗繒浠肩紓浣哄У閻╊垰顫忔繝姘唶闁绘棁銆€婵洭姊虹拠鑼闁绘绻掑Σ鎰板箻鐎靛摜鎳濋梺鎼炲劀閸屾粎娉跨紓鍌氬€风粈渚€藝椤栨粎绀婂┑鐘插亞閸ゆ洖鈹戦悩瀹犲闁告濞婇弻锝夊籍閸偅顥栫紓浣瑰姉閸嬨倕顫忓ú顏勭闁圭粯甯婄花鑲╃磽娴ｇ瓔鍤欓柛濠傜秺楠炲牓濡搁敂钘夊妳闂侀潧顭懙褰掑箯閾忓湱纾藉ù锝呭濡插憡淇婇锝庢疁鐎规洘婢橀埥澶婎潨閸℃娅婇梻渚€娼чˇ顐﹀疾濠婂煻澶愬幢濡ゅ﹦鍞甸柣鐘烘〃鐠€锕傚磿閹寸姷纾奸柍閿亾闁稿鎸搁埞鎴︽偐閸偅姣勬繝娈垮枟閹稿啿鐣烽幇鏉跨濞达絿顭堥崵鎴︽⒑闂堟稓澧曟い锔垮嵆閹繝寮撮姀鐘殿啇缂備緡鍠栭崢婊堝磻閹捐绠涘ù锝囶焾鍞紓?
router.post('/calendar', async (req, res) => {
  const { title, date, start_time, end_time, type, student_id } = req.body
  try {
    const [result] = await pool.query(
      'INSERT INTO calendar_events (teacher_id, student_id, title, date, start_time, end_time, type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, student_id || null, title, date, start_time, end_time, type]
    )
    res.json({ id: result.insertId, message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾剧懓顪冪€ｎ亝鎹ｉ柣顓炴閵嗘帒顫濋敐鍛婵°倗濮烽崑鐐烘偋閻樻眹鈧線寮撮姀鐘靛幈濠殿喗锕╅崢浠嬪Φ濠靛棌鏀介梽鍥春閺嵮屽殫闁告洦鍘搁崑鎾绘晲鎼存繄鑳哄┑鈥冲级閸旀瑥顫忕紒妯肩懝闁逞屽墮椤洩顦跺褎绻堝娲传閸曨剙娅ら梺鐑╂櫓閸ㄥ爼鐛箛娑樼闁挎棁妫勬禍婊堟煟韫囨挾绠ｉ柣鎺炵畵瀵剟鍩€椤掑嫭鈷掑ù锝堟鐢盯鏌ㄥ鎵佸亾濞堝灝鏋涢柣鏍с偢閻涱噣寮介鐐电杸濡炪倖鏌ㄦ晶浠嬫晬濠婂喚娓婚柕鍫濇婵倿鏌涢妸褏甯涢柡鍛劦濮婄粯鎷呴崨濠冨創闂佸搫鐗滈崜娆戝弲濠碘槅鍨拃锕傚吹濡ゅ懏鐓曢柡鍥ュ妼閻忕娀姊洪崡鐐村缂佺粯绻堝Λ鍐ㄢ槈濞嗘ɑ顥ｆ俊鐐€ら崑鍛村箲閸パ屾綎缂備焦蓱婵潙銆掑鐓庣仭缂傚秴锕娲川婵犲倸顫岄梺璇茬箲缁诲啰鈧潧銈搁獮鍥偋閸碍瀚介梻浣规偠閸庢粎浠﹂幏妯犲懐纾藉ù锝堟鐢稓绱掔拠鎻掓殶闁瑰箍鍨归埞鎴犫偓锝庝簽閿涙粌鈹戦鏂や緵闁告鍋撶粋宥嗐偅閸愨斁鎷绘繛杈剧导鐠€锕傛倿閹灛鏃堟偐閸欏鍠愰梺閫炲苯澧紒瀣墦瀵彃鈹戠€ｎ亞顔?
router.put('/calendar/:eventId', async (req, res) => {
  const { title, date, start_time, end_time, type } = req.body
  try {
    await pool.query(
      'UPDATE calendar_events SET title = ?, date = ?, start_time = ?, end_time = ?, type = ? WHERE id = ? AND teacher_id = ?',
      [title, date, start_time, end_time, type, req.params.eventId, req.user.id]
    )
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌熼梻瀵割槮缁炬儳顭烽弻锝夊箛椤掍焦鍎撻梺鎼炲妼閸婂潡寮诲☉銏╂晝闁挎繂妫涢ˇ銉х磽娴ｅ搫小闁告濞婂濠氭偄閸忓皷鎷婚柣搴ｆ暩椤牊淇婃禒瀣拺闁告繂瀚崳铏圭磼鐠囪尙澧︾€殿喖顭锋俊鎼佸Ψ閵忊剝鏉搁梻浣虹《閸撴繈鏁嬪銈忚吂閺呮盯鈥旈崘顔嘉ч幖绮光偓鑼嚬婵犵數鍋犵亸娆撳窗閺嵮屽殨閻犲洦绁村Σ鍫ユ煏韫囨洖啸妞ゆ梹甯″娲嚃閳圭偓瀚涢梺鍛婃尰閻燂附绌辨繝鍐浄閻庯綆鍋嗛崢浠嬫煙閸忚偐鏆橀柛銊ヮ煼閵嗗倿鎳犻钘変壕闁稿繐顦禍楣冩⒑瑜版帗锛熺紒鈧笟鈧幏鎴︽偄閸濄儳顔曢梺鐟扮摠閻熴儵鎮橀埡鍐＜闁绘鏁哥敮娑樓庨崶褝韬柟顔界懄閿涙劕鈹戦崱姗嗗敳婵犵數鍋涢悺銊у垝閹惧墎涓嶉柡宓本缍庡┑鐐叉▕娴滄粍瀵奸悩缁樼厱闁哄洢鍔屽▍妯荤箾閻撳海鍩ｆ慨濠呮缁瑩宕犻埄鍐╂毎缂傚倷娴囬褔宕愰崸妤佹櫜闁绘劕澧庨悿鈧梺鐟板綖閻掞箑顪冩禒瀣ㄢ偓渚€寮崼婵堫槹濡炪倖鎸嗛崟鎴欏€濆娲嚒閵堝懏鐎剧紓渚囧枛閻偐鍒掗弮鍫熷仺闁汇垻鏁搁悞鍧楁倵楠炲灝鍔氭俊顐㈤叄瀹曟垿宕ㄧ€涙鍘遍梺纭呭焽閸斿秴鈻嶉崨顒?
router.put('/calendar/:eventId/link', async (req, res) => {
  const { link, replay_link, linkType } = req.body
  try {
    if (linkType === 'replay') {
      await pool.query(
        'UPDATE calendar_events SET replay_link = ? WHERE id = ? AND teacher_id = ?',
        [replay_link || link, req.params.eventId, req.user.id]
      )
    } else {
      await pool.query(
        'UPDATE calendar_events SET link = ? WHERE id = ? AND teacher_id = ?',
        [link, req.params.eventId, req.user.id]
      )
    }
    res.json({ message: 'ok' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 上传1v1直播/录播链接 → 存入学习路径任务 meta_json
router.post('/live-link', async (req, res) => {
  const { studentId, courseType, linkType, link, pointName } = req.body
  if (!studentId || !courseType || !linkType || !link || !pointName) {
    return res.status(400).json({ message: '缺少必要参数' })
  }
  const def = LIVE_TASK_DEFS.find((d) => d.courseType === courseType)
  if (!def) return res.status(400).json({ message: '无效的课程类型' })

  const taskId   = linkType === 'replay' ? def.replayTaskId : def.liveTaskId
  const metaKey  = linkType === 'replay' ? 'replayVideoId' : 'liveUrl'
  const safePoint = normalizeCheckpointName(pointName)

  try {
    // 验证该学生属于该老师
    const [[ts]] = await pool.query(
      'SELECT 1 FROM teacher_students WHERE teacher_id = ? AND student_id = ? LIMIT 1',
      [req.user.id, studentId]
    )
    if (!ts) return res.status(403).json({ message: '无权操作' })

    // 读取现有 meta_json
    const [[existing]] = await pool.query(
      `SELECT id, meta_json FROM student_learning_path_tasks
       WHERE student_id = ? AND point_name = ? AND stage_key = ? AND task_id = ? LIMIT 1`,
      [studentId, safePoint, def.stageKey, taskId]
    )
    let meta = {}
    if (existing) {
      try { meta = JSON.parse(existing.meta_json || '{}') } catch { meta = {} }
    }
    meta[metaKey] = link

    await pool.query(
      `INSERT INTO student_learning_path_tasks
         (student_id, point_name, stage_key, task_id, is_done, status, meta_json, updated_by_role, updated_by_id)
       VALUES (?, ?, ?, ?, 0, 'pending', ?, 'teacher', ?)
       ON DUPLICATE KEY UPDATE
         meta_json = VALUES(meta_json),
         status = IF(status IS NULL OR status = '', 'pending', status),
         updated_by_role = 'teacher',
         updated_by_id = VALUES(updated_by_id),
         updated_at = NOW()`,
      [studentId, safePoint, def.stageKey, taskId, JSON.stringify(meta), req.user.id]
    )
    res.json({ message: 'ok' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌熼梻瀵割槮缁炬儳顭烽弻锝夊箛椤掍焦鍎撻梺鎼炲妼閸婂潡寮诲☉銏╂晝闁挎繂妫涢ˇ銉х磽娴ｅ搫小闁告濞婂濠氭偄閸忓皷鎷婚柣搴ｆ暩椤牊淇婃禒瀣拺闁告繂瀚崳铏圭磼鐠囪尙澧︾€殿喖顭锋俊鎼佸Ψ閵忊剝鏉搁梻浣虹《閸撴繈鏁嬪銈忚吂閺呮盯鈥旈崘顔嘉ч幖绮光偓鑼嚬婵犵數鍋犵亸娆撳窗閺嵮屽殨閻犲洦绁村Σ鍫ユ煏韫囨洖啸妞ゆ梹甯″娲嚃閳圭偓瀚涢梺鍛婃尰閻燂附绌辨繝鍐浄閻庯綆鍋嗛崢浠嬫煙閸忚偐鏆橀柛銊ヮ煼閵嗗倿鎳犻钘変壕闁稿繐顦禍楣冩⒑瑜版帗锛熺紒鈧笟鈧幏鎴︽偄閸濄儳顔曢梺鐟扮摠閻熴儵鎮橀埡鍐＜闁绘鏁哥敮娑樓庨崶褝韬柟顔界懄閿涙劕鈹戦崱姗嗗敳婵犵數鍋涢悺銊у垝閹惧墎涓嶉柡宓本缍庡┑鐐叉▕娴滄粍瀵奸悩缁樼厱闁哄洢鍔屽▍妯荤箾閻撳海鍩ｆ慨濠呮缁瑩宕犻埄鍐╂毎缂傚倷娴囬褔鎮ч崱娑辨晪闁挎繂娲︾€氭碍绻涢弶鎴剱妞ゎ偄绉瑰娲濞戞氨顔婃繝娈垮枛閻楁挻淇婂宀婃Ъ闂佸摜濮甸崝妤呭焵椤掆偓缁犲秹宕曢崡鐐嶆稑鈽夐～顑藉亾閸涘瓨鍊婚柤鎭掑劤閸欏棝姊洪崫鍕窛闁稿鐩崺鈧い鎺嗗亾缂傚秴锕獮鍐灳閺傘儲顫嶉梺闈涢獜缁辨洟宕㈤柆宥嗙厽闊洦娲栨禒婊冾熆瑜岀划娆撶嵁婵犲洤宸濇い鏍ㄧ矌閿涙粓姊鸿ぐ鎺戜喊闁告ü绮欒棢闁割偁鍎查悡娑氣偓鍏夊亾閻庯綆鍓涢敍鐔哥箾鐎电顎撶紒鐘虫崌楠炲啴濮€閵堝棛鍙嗛柣搴秵娴滆泛危闁秵鈷掑ù锝勮閻掗箖鏌ㄩ弴銊ら偗鐎殿喓鍔戦弻鍡楊吋閸涘偊绠撻弻娑㈠即閵娿儳浠╃紓浣哄У婵炲﹪寮诲☉銏犵労闁告劧缂氬▽顏呯節閵忥綆娼愭繛鍙夌墵閸?
router.post('/materials/replay', async (req, res) => {
  const { eventId, link, category } = req.body
  if (!eventId || !link) return res.status(400).json({ message: '????' })

  try {
    const [[event]] = await pool.query(
      'SELECT id, teacher_id, student_id, title FROM calendar_events WHERE id = ? AND teacher_id = ? LIMIT 1',
      [eventId, req.user.id],
    )
    if (!event) return res.status(404).json({ message: '????' })

    await pool.query(
      `INSERT INTO lesson_materials (teacher_id, student_id, calendar_event_id, material_type, title, url)
       VALUES (?, ?, ?, 'replay', ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), url = VALUES(url), created_at = NOW()`,
      [req.user.id, event.student_id, event.id, `${category || '??'}???${event.title || '??'}`, link],
    )

    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌熼梻瀵割槮缁炬儳顭烽弻锝夊箛椤掍焦鍎撻梺鎼炲妼閸婂潡寮诲☉銏╂晝闁挎繂妫涢ˇ銉х磽娴ｅ搫小闁告濞婂濠氭偄閸忓皷鎷婚柣搴ｆ暩椤牊淇婃禒瀣拺闁告繂瀚崳铏圭磼鐠囪尙澧︾€殿喖顭锋俊鎼佸Ψ閵忊剝鏉搁梻浣虹《閸撴繈鏁嬪銈忚吂閺呮盯鈥旈崘顔嘉ч幖绮光偓鑼嚬婵犵數鍋犵亸娆撳窗閺嵮屽殨閻犲洦绁村Σ鍫ユ煏韫囨洖啸妞ゆ梹甯″娲嚃閳圭偓瀚涢梺鍛婃尰閻燂附绌辨繝鍐浄閻庯綆鍋嗛崢浠嬫煙閸忚偐鏆橀柛銊ヮ煼閵嗗倿鎳犻钘変壕闁稿繐顦禍楣冩⒑瑜版帗锛熺紒鈧笟鈧幏鎴︽偄閸忚偐鍘介梺鍝勫暙閸婄敻骞忛敓鐘崇厸濞达絽鎽滄晥闂佸搫鏈惄顖炲春閸曨垰绀冮柣鎰靛墰閺嗐儲淇婇悙顏勨偓鏇犳崲閸℃稑鐤鹃柣妯款嚙閽冪喓鈧箍鍎遍悧婊冾瀶閵娾晜鈷戦柛娑橈攻鐏忎即鏌ｉ埡濠傜仩妞ゆ洩缍侀、鏇㈡晲閸モ晝妲囨繝娈垮枟閿曗晠宕滃☉銏″仼婵炲樊浜濋悡鐔兼煟閺傛寧鎲搁柟鍐插暣閹顫濋悡搴＄闂佸憡甯掗敃顏堢嵁濮椻偓椤㈡瑩鎮剧仦钘夌睄濠电姷顣藉Σ鍛村垂椤栨粍濯伴柨鏇楀亾閸楅亶鏌涘┑鍡楊伌闁绘柨妫濋幃褰掑传閸曨剚鍎撳銈呮禋閸嬪棛妲?
// 通用 PDF 上传，返回可访问 URL
router.post('/upload/pdf', uploadMaterial.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '请上传文件' })
  const ext = path.extname(req.file.originalname).toLowerCase()
  if (ext !== '.pdf') {
    fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
    return res.status(400).json({ message: '只支持 PDF 文件' })
  }
  const url = `/uploads/${req.file.filename}`
  res.json({ url, storedFile: req.file.filename })
})

router.post('/materials/handout', uploadMaterial.single('file'), async (req, res) => {
  const { taskRowId } = req.body
  if (!taskRowId) {
    if (req.file) fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
    return res.status(400).json({ message: '缺少任务节点ID' })
  }
  if (!req.file) return res.status(400).json({ message: '请上传文件' })

  try {
    const [[task]] = await pool.query(
      `SELECT slpt.id, slpt.student_id, slpt.point_name, slpt.stage_key, slpt.task_id
       FROM student_learning_path_tasks slpt
       JOIN teacher_students ts ON ts.student_id = slpt.student_id AND ts.teacher_id = ?
       WHERE slpt.id = ?
       LIMIT 1`,
      [req.user.id, taskRowId],
    )
    if (!task) {
      fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
      return res.status(404).json({ message: '任务节点不存在或无权限' })
    }

    const title = task.point_name + ' · ' + req.file.originalname

    await pool.query(
      `INSERT INTO lesson_materials
         (teacher_id, student_id, point_name, stage_key, task_id, material_type, title, file_name, stored_file)
       VALUES (?, ?, ?, ?, ?, 'handout', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         file_name = VALUES(file_name),
         stored_file = VALUES(stored_file),
         created_at = NOW()`,
      [req.user.id, task.student_id, task.point_name, task.stage_key, task.task_id, title, req.file.originalname, req.file.filename],
    )

    res.json({ message: '上传成功' })
  } catch (err) {
    fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {})
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾圭€瑰嫭鍣磋ぐ鎺戠倞妞ゆ帒顦伴弲顏堟偡濠婂啰效婵犫偓娓氣偓濮婅櫣绱掑Ο铏逛紘濠碘槅鍋勭€氼喚鍒掓繝姘亹缂備焦顭囬崢鐢告⒑绾拋娼愰柛鏃撶畵瀹曢潧鈻庨幘鏉戔偓鍨叏濮楀棗澧绘俊鎻掔秺閺屾洟宕惰椤忣厽顨ラ悙鏉戞诞妤犵偛顑呴埞鎴﹀箛椤忓懎浜濋梻鍌氬€烽悞锕傚箖閸洖绀夌€光偓閸曨偆锛欓悷婊呭鐢帞绮婚悙鐑樼厪濠电偛鐏濋崜濠氭煟閺冨偆鐒剧紒鍓佸仧缁辨帞鈧綆鍋勯婊堟煕鎼淬垺灏电紒杈ㄦ尰閹峰懘宕崟顏勵棜闂備胶顭堢€涒晜绻涙繝鍐х箚闁割偅娲栫粻鐟懊归敐鍡欐憙闁硅姤娲栭埞鎴︽倷閺夋垹浠ч梺鎼炲妼濠€杈╁垝鐠囨祴妲堥柕蹇娾偓鏂ュ亾閸洘鐓熼柟閭﹀灡绾墽鎮鑸碘拺闂傚牃鏅濈粔顒€鈹戦鍝勨偓鏍矚鏉堛劎绡€闁搞儜鍛幀濠电姰鍨煎▔娑㈡晝閿旇棄顕遍悘鐐缎掗弨鑺ャ亜閺冨倶鈧寮ㄧ紒妯圭箚闁绘劘鍩栭ˉ澶愭煟閿濆洤鍘村┑鈩冩倐閺佸倿宕滆濡插洭姊绘担渚劸闁哄牜鍓涢崚鎺撴償閵娿儳鐤囬梺绯曞墲椤洨寮ч埀顒傜磼閸撗冾暭閽冭鲸銇勯顫含闁哄本绋撻埀顒婄秵娴滄繈宕虫禒瀣厵妤犵偛鐏濋悘鑼偓瑙勬礈閸樠囧煘閹达箑閱囬柣鏂垮閸熷酣姊婚崒娆戠獢婵炰匠鍛床闁割偁鍎辩壕褰掓煛閸モ晛浠︾紒缁㈠灦濮婂宕掑▎鎺戝帯缂佺虎鍘奸悥鐓庣暦濠婂啠鏀介悗锝庡亜娴狀厼顪冮妶鍡欏妞ゆ洏鍨奸妵鎰板箳閹寸媭妲规俊鐐€栭悧妤冪矙閹捐鍌ㄥù鐘差儐閳锋垹绱撴担鍏夋（妞ゅ繐瀚烽崵鏇㈡煠閹间焦娑х紒鍓佸仱閺屾盯寮撮妸銉ョ闂佸摜濮甸崝娆撳蓟閳╁啫绶炲┑鐘插閾忓酣姊洪崫鍕紨缂傚秳绶氬?
// ??????????????
router.post('/practice-assignment-tasks/:taskId/assign', async (req, res) => {
  const rawTaskId = String(req.params.taskId || '').replace(/^assign_/, '')
  const virtualStudentId = rawTaskId.startsWith('student_') ? Number(rawTaskId.replace(/^student_/, '')) : 0
  const taskId = virtualStudentId ? 0 : Number(rawTaskId)
  if (!taskId && !virtualStudentId) return res.status(400).json({ message: '????' })

  const checkpointName = normalizeCheckpointName(req.body.checkpointName || req.body.checkpoint || '')
  if (!checkpointName) return res.status(400).json({ message: '????' })

  const sortOrder = Number(req.body.sortOrder) >= 0 ? Number(req.body.sortOrder) : 0

  const version = String(req.body.version || '').trim()
  const versionName = String(req.body.versionName || '').trim()
  const province = String(req.body.province || '').trim()
  const provinceLabel = String(req.body.provinceLabel || '').trim()
  const detail = String(req.body.detail || '').trim()

  const knowledgeItems = Array.isArray(req.body.knowledgeItems)
    ? req.body.knowledgeItems
      .map((item) => ({
        id: String((item && item.id) || '').trim(),
        title: String((item && item.title) || '').trim(),
        type: String((item && item.type) || '').trim(),
        desc: String((item && item.desc) || '').trim(),
      }))
      .filter((item) => item.id || item.title)
    : []

  const theoryLessons = Array.isArray(req.body.theoryLessons)
    ? req.body.theoryLessons
      .map((item) => ({
        id: String((item && item.id) || '').trim(),
        title: String((item && item.title) || '').trim(),
        scope: String((item && item.scope) || '').trim(),
        videoId: String((item && item.videoId) || '').trim(),
        preClassUrl: String((item && item.preClassUrl) || '').trim(),
        analysisUrl: String((item && item.analysisUrl) || '').trim(),
        noteText: String((item && item.noteText) || '').trim(),
        knowledgeId: String((item && item.knowledgeId) || '').trim(),
        knowledgeTitle: String((item && item.knowledgeTitle) || '').trim(),
        knowledgeType: String((item && item.knowledgeType) || '').trim(),
      }))
      .filter((item) => item.id || item.title || item.videoId || item.preClassUrl || item.analysisUrl)
    : []

  const practiceIds = Array.isArray(req.body.practiceIds)
    ? req.body.practiceIds.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  const examIds = Array.isArray(req.body.examIds)
    ? req.body.examIds.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  const normalizeAssignmentItems = (items = []) => (
    Array.isArray(items)
      ? items
        .map((item) => ({
          id: String((item && item.id) || '').trim(),
          kind: String((item && item.kind) || '').trim(),
          slotKey: String((item && item.slotKey) || '').trim(),
          rawTitle: String((item && item.rawTitle) || '').trim(),
          questionTitle: String((item && item.questionTitle) || '').trim(),
          displayTitle: String((item && item.displayTitle) || '').trim(),
          videoId: String((item && item.videoId) || '').trim(),
          preClassUrl: String((item && item.preClassUrl) || '').trim(),
          analysisUrl: String((item && item.analysisUrl) || '').trim(),
          provinceKeys: Array.isArray(item && item.provinceKeys)
            ? item.provinceKeys.map((key) => String(key || '').trim()).filter(Boolean)
            : [],
        }))
        .filter((item) => (
          item.id
          || item.displayTitle
          || item.questionTitle
          || item.rawTitle
          || item.videoId
          || item.preClassUrl
          || item.analysisUrl
        ))
      : []
  )

  const practiceItems = normalizeAssignmentItems(req.body.practiceItems)
  const examItems = normalizeAssignmentItems(req.body.examItems)
  const remedialItems = normalizeAssignmentItems(req.body.remedialItems)
  const selectedTeacherId = Number(req.body.teacher?.id) || 0

  let conn
  try {
    conn = await pool.getConnection()
    await conn.beginTransaction()

    const [[taskRow]] = taskId
      ? await conn.query(
          `SELECT id, student_id
           FROM practice_assignment_tasks
           WHERE id = ?
           LIMIT 1`,
          [taskId],
        )
      : await conn.query(
          `SELECT NULL AS id, id AS student_id
           FROM students
           WHERE id = ?
           LIMIT 1`,
          [virtualStudentId],
        )

    if (!taskRow) {
      return res.status(404).json({ message: '????' })
    }

    const [[selectedTeacher]] = selectedTeacherId
      ? await conn.query(
          `SELECT id, name, COALESCE(title, '') AS title
           FROM teachers
           WHERE id = ?
           LIMIT 1`,
          [selectedTeacherId],
        )
      : [[]]

    if (!selectedTeacher) {
      return res.status(400).json({ message: '????' })
    }

    const studentId = Number(taskRow.student_id)
    const teacherRole = inferTeamRoleFromTitle(selectedTeacher.title)
    const normalizedTeacherInfo = {
      id: String(selectedTeacher.id),
      name: String(selectedTeacher.name || '').trim(),
      role: mapTeamRoleLabel(teacherRole),
      title: String(selectedTeacher.title || '').trim(),
    }

    const assignmentPayload = {
      checkpointName,
      sortOrder,
      version,
      versionName,
      province,
      provinceLabel,
      teacher: normalizedTeacherInfo,
      knowledgeItems,
      theoryLessons,
      practiceIds,
      examIds,
      practiceItems,
      examItems,
      remedialItems,
      detail,
      assignedAt: new Date().toISOString(),
    }

    await ensureTeacherStudentRelation(conn, selectedTeacher.id, studentId)
    await ensureStudentCourseEnrollment(conn, selectedTeacher.id, studentId, checkpointName, theoryLessons, sortOrder)
    await ensureChatRoom(conn, selectedTeacher.id, studentId)
    await conn.query(
      `INSERT INTO student_team_members (student_id, teacher_id, role, status)
       VALUES (?, ?, ?, 'assigned')
       ON DUPLICATE KEY UPDATE
         teacher_id = VALUES(teacher_id),
         status = 'assigned',
         assigned_at = NOW()`,
      [studentId, selectedTeacher.id, teacherRole],
    )

    await conn.query(
      `DELETE FROM student_learning_path_tasks
       WHERE student_id = ?
         AND point_name = ?
         AND stage_key IN ('theory', 'theory_config', 'training', 'exam', 'report', 'drill')`,
      [studentId, checkpointName],
    )

    await saveLearningPathTask({
      studentId,
      pointName: checkpointName,
      stageKey: 'theory_config',
      taskId: 'assignment_config',
      status: 'done',
      metaPatch: assignmentPayload,
      actorRole: 'teacher',
      actorId: req.user.id,
      executor: conn,
    })

    await conn.query(
      `UPDATE practice_assignment_tasks
       SET checkpoint = ?, detail = ?, status = 'assigned', assigned_at = NOW()
       WHERE student_id = ?`,
      [checkpointName, detail, studentId],
    )

    await conn.commit()
    res.json({ ok: true, message: '????' })
  } catch (err) {
    if (conn) await conn.rollback()
    res.status(500).json({ message: err.message })
  } finally {
    if (conn) conn.release()
  }
})

router.post('/practice-assignment-tasks/:taskId/complete', async (req, res) => {
  const rawTaskId = String(req.params.taskId || '').replace(/^assign_/, '')
  const virtualStudentId = rawTaskId.startsWith('student_') ? Number(rawTaskId.replace(/^student_/, '')) : 0
  const taskId = virtualStudentId ? 0 : Number(rawTaskId)
  if (!taskId && !virtualStudentId) return res.status(400).json({ message: '????' })
  if (virtualStudentId) return res.json({ message: '????' })

  try {
    const [result] = await pool.query(
      `UPDATE practice_assignment_tasks
       SET status = 'assigned', assigned_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [taskId],
    )
    if (result.affectedRows === 0) return res.status(404).json({ message: '????' })
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾剧懓顪冪€ｎ亝鎹ｉ柣顓炴閵嗘帒顫濋敐鍛婵°倗濮烽崑娑⑺囬悽绋挎瀬鐎广儱顦粈瀣亜閹哄秶鍔嶆い鏂挎喘濮婄粯鎷呴搹鐟扮闂佸憡姊瑰ú鐔笺€佸棰濇晣闁绘ê鍚€缁楀淇婇妶蹇曞埌闁哥噥鍨堕幃锟犲礃椤忓懎鏋戝┑鐘诧工閻楀棛绮堥崼鐔稿弿婵☆垰娼￠崫铏光偓瑙勬礀瀵墎鎹㈠☉銏犵婵炲棗绻掓禒濂告倵閻熺増鍟炵紒璇插暣婵＄敻宕熼姘鳖啋闂佸憡顨堥崑鐔哥婵傚憡鍊垫繛鍫濈仢閺嬫瑩鏌涘Δ浣糕枙妤犵偛鍟灃闁逞屽墴閸┿垽骞樼拠鎻掔€銈嗘⒒閺咁偉銇愰鐐粹拻濞撴埃鍋撴繛鑹板吹缁辩偤宕堕埡浣虹瓘闂佺粯鍔﹂崜娑㈠煘瀹ュ應鏀介柣妯哄级婢跺嫰鏌涙繝鍌ょ吋闁哄矉绠戣灒闁绘艾顕粈鍡涙⒑闂堟单鍫ュ疾濠婂牊鍋傞煫鍥ㄦ惄閻斿棝鎮规ウ鎸庮仩濠⒀勬礋閺屾盯寮埀顒傚垝鎼达絾顫曢柟鐐墯閸氬鏌涘鈧悞锔剧懅闂傚倷绀侀悿鍥綖婢舵劕鍨傞柛褎顨呯粻鏍ㄧ箾閸℃ɑ灏伴柛銈嗗灦閵囧嫰骞掑鍥у闂佸摜濮甸悧婊呮閹捐纾兼繛鍡樺灱缁愭姊洪崫銉バｉ柣妤冨█楠炲棗鐣濋崟顐わ紲闂佺粯鍔︽禍鏍磻閹惧鐟归柍褜鍓欓锝嗙鐎ｅ灚鏅ｉ梺缁樺姈椤旀牕危鐟欏嫪绻嗛柣鎰典簻閳ь剚鐗犲畷婵單旈崨顓犵崶闂佽澹嗘晶妤呭磹?
router.delete('/calendar/:eventId', async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM calendar_events WHERE id = ? AND teacher_id = ?',
      [req.params.eventId, req.user.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ message: '????' })
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧湱鈧懓瀚崳纾嬨亹閹烘垹鍊為梺闈浤涢崨顓㈢崕闂傚倷绀佹竟濠囧磻閸℃稑绐楅柛鈩冾焽椤╃兘鏌涢鐘茬伄缁炬儳銈搁幃妤呮晲鎼粹€茶埅闂佺绨洪崕鑼崲濞戙垹绀傞柤娴嬫櫅閳綊姊虹€圭媭娼愰柛銊ユ健楠炲啴鍩℃担鐑樻闂佹悶鍎撮崺鏍р枔瑜版帗鈷掑ù锝堟鐢盯鎮介銈囩？缂侇喖顭峰浠嬵敇閻愮數鏆繝寰锋澘鈧劙宕戦幘缁樼厓闁芥ê顦藉Σ鎼佹煃鐠囨煡顎楅摶锝夋煟閹炬娊顎楀Δ鏃€绻濈喊澶岀？闁稿鍨垮畷鎰板箛閺夎法鏌у┑鐘诧工閻楀﹪宕戦崒鐐寸叆闁绘柨鎼瓭闂佽棄鍟伴崰鎰崲濞戙垹绠ｉ柣鎰暞瀹€绋款嚕閵婏妇顩烽悗锝庡亞閸橀亶姊洪弬銉︽珔闁哥姵鑹鹃埢鎾诲閻樺棗缍婇幃鈩冩償閵堝拋浼冮梻浣哥枃椤宕归崸妤€鏄ラ柛鏇ㄥ灠缁€鍐煏婵炑冩噷閸嬶繝姊婚崒娆愮グ妞ゆ泦鍛床闁瑰瓨绻嶅鈺呮煏婵炵偓娅呯紒鐘崇叀閺屾洝绠涢弴鐐愭稒淇婇幓鎺斿缂佺粯鐩畷鍗炍旈崘顏嶅敽缂傚倷鐒﹂崝妤呭磻濞戙垹鐓橀柟杈剧畱閻擄繝鏌涢埄鍐炬畼濞寸媭鍨跺娲川婵犲海鍔堕梺鍛婁緱閸犳鈻撴导瀛樷拺闂傚牊涓瑰☉銏犲窛妞ゆ牓鍊楅梻顖涚節閻㈤潧浠╅柟娲讳簽瀵板﹪鎳栭埡浣哥亰濠电偛妫欓幐鍛婂閻樺磭绠剧€瑰壊鍠曠花濂告煟閹捐泛鏋戠紒缁樼洴楠炲鎮欓崹顐㈡珣闂備浇妗ㄩ懗鍓佷焊椤ょct_notes闂?
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
    res.json({ id: result.insertId, message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.delete('/contact-notes/:noteId', async (req, res) => {
  try {
    await pool.query('DELETE FROM contact_notes WHERE id = ? AND teacher_id = ?',
      [req.params.noteId, req.user.id])
    res.json({ message: '????' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 获取所有课程列表（用于分配课程弹窗）
router.get('/courses', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, subject, description FROM courses WHERE is_active = 1 ORDER BY subject, name'
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 给学生分配课程
router.post('/students/:studentId/courses', async (req, res) => {
  const { studentId } = req.params
  const { courseId } = req.body
  if (!courseId) return res.status(400).json({ message: '缺少 courseId' })
  try {
    const [[course]] = await pool.query('SELECT id FROM courses WHERE id = ? AND is_active = 1', [courseId])
    if (!course) return res.status(404).json({ message: '课程不存在' })
    await pool.query(
      `INSERT INTO student_courses (student_id, course_id, progress, status)
       VALUES (?, ?, 0, 'in_progress')
       ON DUPLICATE KEY UPDATE status = IF(status = 'failed', 'in_progress', status)`,
      [studentId, courseId]
    )
    res.json({ message: '分配成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// 单独开通诊断课或刷题课
router.post('/students/:studentId/special-course', async (req, res) => {
  const { studentId } = req.params
  const { type } = req.body
  if (!type || !['diagnose', 'drill'].includes(type)) {
    return res.status(400).json({ message: 'type 必须为 diagnose 或 drill' })
  }
  try {
    await pool.query(
      `INSERT INTO student_special_courses (student_id, type, granted_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by), created_at = NOW()`,
      [studentId, type, req.user.id]
    )
    res.json({ message: '开通成功' })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

router.get('/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, title FROM teachers ORDER BY id ASC')
    res.json({ list: rows.map((r) => ({ id: String(r.id), name: r.name, title: r.title ?? '' })) })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

module.exports = router
