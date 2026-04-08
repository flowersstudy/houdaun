const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')
const { getDbConfig } = require('../config/env')

const UPLOADS_DIR = path.join(__dirname, 'uploads')
const SAMPLE_PDF_NAME = 'sample-seed.pdf'
const SAMPLE_PDF_PATH = path.join(UPLOADS_DIR, SAMPLE_PDF_NAME)

const teachers = [
  { key: 'li', name: '???', email: 'li@test.com', title: '????' },
  { key: 'wang', name: '???', email: 'wang@test.com', title: '????' },
  { key: 'chen', name: '???', email: 'chen@test.com', title: '??' },
  { key: 'lin', name: '???', email: 'lin@test.com', title: '????' },
  { key: 'liu', name: '???', email: 'liu@test.com', title: '??' },
]

const courseCatalog = [
  { name: '??????', subject: '??', description: '???????????', price: 1080 },
  { name: '????', subject: '??', description: '????????????', price: 1080 },
  { name: '????', subject: '??', description: '?????????????', price: 1080 },
  { name: '????', subject: '??', description: '????????????', price: 1080 },
  { name: '????', subject: '??', description: '????????????', price: 1080 },
  { name: '????', subject: '??', description: '????????????', price: 1080 },
  { name: '????', subject: '??', description: '????????????', price: 1080 },
  { name: '?????', subject: '??', description: '????????????', price: 1080 },
]

const students = [
  {
    key: 's1',
    openid: 'dev_openid_001',
    phone: '13800000001',
    name: '???',
    status: 'normal',
    grade: '2026?',
    subject: '??',
    coachKey: 'li',
    diagnosisKey: 'wang',
    managerKey: 'chen',
    principalKey: 'liu',
    lastSession: '2026-04-04',
    profile: { gender: 'male', hometown: '??', exam_status: '???', exam_date: '2026-04-26', education: '??', major: '?????', avatar_url: '' },
    course: { name: '??????', progress: 43, status: 'in_progress' },
    noteTexts: ['??????????????????????????', '?????????????????????'],
    flag: null,
    diagnosis: {
      target_exam: '????', target_score: 130, diagnosis_score: 108, diagnosis_date: '2026-04-03', teacher_comment: '??????????????????????',
      points: [
        { point_name: '??????', priority: 'high', description: '?????????', sort_order: 1 },
        { point_name: '????', priority: 'medium', description: '????????????', sort_order: 2 },
      ],
    },
    handoutTitle: '???? 1', replayTitle: '???? 1', answerTitle: '?? 1', answerScore: 12,
    calendar: [
      { title: '??? ? ???', date: '2026-04-04', start: '09:00', end: '10:30', type: 'class', link: 'https://meeting.example.com/wang-1' },
      { title: '???? ? ???', date: '2026-04-08', start: '19:30', end: '20:00', type: 'meeting', link: null },
    ],
    chatMessages: [
      ['teacher', '???', '??????????????????'],
      ['student', '???', '?????????????????'],
      ['teacher', '???', '???????????????????'],
    ],
    submissions: [
      { id: 'pdf_s1_1', reviewType: '?????', checkpoint: '??????', deadline: '2026-04-08 12:00:00', priority: 'normal', submittedNormal: 1, fileName: '???-??????.pdf', graded: 1, score: 12, feedback: '????????????????', gradedAt: '2026-04-06 21:00:00', createdAt: '2026-04-06 09:30:00' },
    ],
    notification: { type: 'class', title: '?? ? ???', content: '?? 09:00 ??????????', related_type: 'calendar_event', related_id: 'wang_class_1', scheduled_at: '2026-04-07 20:00:00' },
    outlineItems: [
      { type: 'listen', content: '?????????', sort_order: 1 },
      { type: 'write', content: '??????????', sort_order: 2 },
    ],
  },
  {
    key: 's2', openid: 'dev_openid_002', phone: '13800000002', name: '???', status: 'new', grade: '2026?', subject: '??', coachKey: 'li', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-04-03',
    profile: { gender: 'female', hometown: '??', exam_status: '????', exam_date: '2026-04-26', education: '??', major: '????', avatar_url: '' },
    course: { name: '????', progress: 18, status: 'in_progress' },
    noteTexts: ['??????????????????????', '???????????????????????'],
    flag: null,
    diagnosis: {
      target_exam: '????', target_score: 125, diagnosis_score: 96, diagnosis_date: '2026-04-02', teacher_comment: '?????????????????????',
      points: [
        { point_name: '????', priority: 'high', description: '????????', sort_order: 1 },
        { point_name: '??????', priority: 'medium', description: '?????', sort_order: 2 },
      ],
    },
    handoutTitle: '??????', replayTitle: '?????', answerTitle: '??????', answerScore: 14,
    calendar: [
      { title: '??? ? ???', date: '2026-04-03', start: '14:00', end: '15:30', type: 'class', link: null },
      { title: '???? ? ???', date: '2026-04-09', start: '20:00', end: '20:30', type: 'meeting', link: null },
    ],
    chatMessages: [
      ['student', '???', '???????????'],
      ['teacher', '???', '??????????????'],
    ],
    submissions: [
      { id: 'pdf_s2_1', reviewType: '????', checkpoint: '????', deadline: '2026-04-07 12:00:00', priority: 'urgent', submittedNormal: 1, fileName: '???-????.pdf', graded: 0, score: null, feedback: null, gradedAt: null, createdAt: '2026-04-07 08:30:00' },
    ],
    notification: { type: 'review', title: '???????', content: '????????????????', related_type: 'submission', related_id: 'pdf_s2_1', scheduled_at: '2026-04-07 08:40:00' },
    outlineItems: [
      { type: 'listen', content: '?????????', sort_order: 1 },
      { type: 'write', content: '???????? 1', sort_order: 2 },
    ],
  },
  {
    key: 's3', openid: 'dev_openid_003', phone: '13800000003', name: '???', status: 'normal', grade: '2026?', subject: '??', coachKey: 'wang', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-04-02',
    profile: { gender: 'male', hometown: '??', exam_status: '?????', exam_date: '2026-05-10', education: '??', major: '??', avatar_url: '' },
    course: { name: '????', progress: 32, status: 'in_progress' },
    noteTexts: ['??????????????????', '???????????????????'],
    flag: { flagged: 1, reason: '????????????????', severity: 'high' },
    diagnosis: {
      target_exam: '????', target_score: 128, diagnosis_score: 92, diagnosis_date: '2026-04-03', teacher_comment: '????????????????????',
      points: [
        { point_name: '????', priority: 'high', description: '???????', sort_order: 1 },
        { point_name: '????', priority: 'medium', description: '???????', sort_order: 2 },
      ],
    },
    handoutTitle: '??????', replayTitle: '????', answerTitle: '???', answerScore: 10,
    calendar: [
      { title: '??? ? ???', date: '2026-04-02', start: '10:00', end: '11:00', type: 'class', link: null },
      { title: '???? ? ???', date: '2026-04-08', start: '16:00', end: '16:30', type: 'meeting', link: null },
    ],
    chatMessages: [
      ['student', '???', '????????????'],
      ['teacher', '???', '?????????????????'],
    ],
    submissions: [
      { id: 'pdf_s3_1', reviewType: '????', checkpoint: '????', deadline: '2026-04-07 10:00:00', priority: 'urgent', submittedNormal: 0, fileName: '???-????.pdf', graded: 0, score: null, feedback: null, gradedAt: null, createdAt: '2026-04-07 07:45:00' },
    ],
    notification: { type: 'system', title: '???????', content: '?????????????????????', related_type: 'student_flag', related_id: 's3', scheduled_at: '2026-04-07 09:00:00' },
    outlineItems: [
      { type: 'listen', content: '????????????', sort_order: 1 },
      { type: 'write', content: '????? 2 ?', sort_order: 2 },
    ],
  },
  {
    key: 's4', openid: 'dev_openid_004', phone: '13800000004', name: '???', status: 'normal', grade: '2026?', subject: '??', coachKey: 'chen', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-04-01',
    profile: { gender: 'female', hometown: '??', exam_status: '???', exam_date: '2026-05-10', education: '??', major: '???', avatar_url: '' },
    course: { name: '????', progress: 24, status: 'in_progress' },
    noteTexts: ['??????????????????', '???????????????'], flag: null,
    diagnosis: {
      target_exam: '????', target_score: 126, diagnosis_score: 101, diagnosis_date: '2026-04-01', teacher_comment: '?????????????????????',
      points: [{ point_name: '????', priority: 'high', description: '???????', sort_order: 1 }],
    },
    handoutTitle: '??????', replayTitle: '?????', answerTitle: '????', answerScore: 11,
    calendar: [{ title: '??? ? ???', date: '2026-04-01', start: '13:30', end: '14:30', type: 'class', link: 'https://meeting.example.com/liu-1' }],
    chatMessages: [
      ['student', '???', '??????????????'],
      ['teacher', '???', '?????????????????????'],
    ],
    submissions: [],
    notification: { type: 'homework', title: '??????', content: '?? 23:59 ??????????', related_type: 'study_task', related_id: 's4_task_4', scheduled_at: '2026-04-07 12:00:00' },
    outlineItems: [
      { type: 'listen', content: '????????', sort_order: 1 },
      { type: 'write', content: '????????', sort_order: 2 },
    ],
  },
  {
    key: 's5', openid: 'dev_openid_005', phone: '13800000005', name: '???', status: 'normal', grade: '2026?', subject: '??', coachKey: 'chen', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-03-28',
    profile: { gender: 'male', hometown: '??', exam_status: '????', exam_date: '2026-05-18', education: '??', major: '???', avatar_url: '' },
    course: { name: '????', progress: 8, status: 'in_progress' },
    noteTexts: ['?????????????????', '????????????????????'],
    flag: { flagged: 1, reason: '???????????????????', severity: 'medium' },
    diagnosis: {
      target_exam: '?????', target_score: 124, diagnosis_score: 88, diagnosis_date: '2026-03-29', teacher_comment: '???????????????????????',
      points: [
        { point_name: '????', priority: 'high', description: '???????', sort_order: 1 },
        { point_name: '??????', priority: 'medium', description: '?????????', sort_order: 2 },
      ],
    },
    handoutTitle: '??????', replayTitle: '?????', answerTitle: '??????', answerScore: 8,
    calendar: [{ title: '??? ? ???', date: '2026-03-28', start: '18:30', end: '19:30', type: 'class', link: null }],
    chatMessages: [
      ['student', '???', '??????????????'],
      ['teacher', '???', '?????????????????????'],
    ],
    submissions: [
      { id: 'pdf_s5_1', reviewType: '????', checkpoint: '????', deadline: '2026-04-08 18:00:00', priority: 'low', submittedNormal: 0, fileName: '???-????.pdf', graded: 0, score: null, feedback: null, gradedAt: null, createdAt: '2026-04-06 22:00:00' },
    ],
    notification: { type: 'system', title: '??????', content: '????????????????????', related_type: 'student_flag', related_id: 's5', scheduled_at: '2026-04-07 09:10:00' },
    outlineItems: [
      { type: 'listen', content: '?????????', sort_order: 1 },
      { type: 'write', content: '??? 1 ???????', sort_order: 2 },
    ],
  },
  {
    key: 's6', openid: 'dev_openid_006', phone: '13800000006', name: '???', status: 'normal', grade: '2026?', subject: '??', coachKey: 'wang', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-04-05',
    profile: { gender: 'female', hometown: '??', exam_status: '???', exam_date: '2026-06-15', education: '??', major: '???', avatar_url: '' },
    course: { name: '????', progress: 67, status: 'in_progress' },
    noteTexts: ['???????????????', '??????????????????'], flag: null,
    diagnosis: {
      target_exam: '?????', target_score: 122, diagnosis_score: 106, diagnosis_date: '2026-04-05', teacher_comment: '????????????????????',
      points: [{ point_name: '????', priority: 'medium', description: '?????????', sort_order: 1 }],
    },
    handoutTitle: '??????', replayTitle: '?????', answerTitle: '??????', answerScore: 15,
    calendar: [{ title: '??? ? ???', date: '2026-04-05', start: '09:00', end: '10:00', type: 'class', link: 'https://meeting.example.com/sun-1' }],
    chatMessages: [
      ['student', '???', '????????????'],
      ['teacher', '???', '??????????????????'],
    ],
    submissions: [
      { id: 'pdf_s6_1', reviewType: '?????', checkpoint: '????', deadline: '2026-04-07 16:00:00', priority: 'normal', submittedNormal: 1, fileName: '???-????.pdf', graded: 1, score: 15, feedback: '????????????????', gradedAt: '2026-04-06 20:10:00', createdAt: '2026-04-06 09:50:00' },
    ],
    notification: { type: 'review', title: '??????', content: '???????????', related_type: 'study_task', related_id: 's6_task_6', scheduled_at: '2026-04-07 19:00:00' },
    outlineItems: [
      { type: 'listen', content: '???????', sort_order: 1 },
      { type: 'write', content: '?????? 2 ?', sort_order: 2 },
    ],
  },
  {
    key: 's7', openid: 'dev_openid_007', phone: '13800000007', name: '???', status: 'normal', grade: '2026?', subject: '??', coachKey: 'lin', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-04-05',
    profile: { gender: 'male', hometown: '??', exam_status: '????', exam_date: '2026-07-20', education: '??', major: '???', avatar_url: '' },
    course: { name: '????', progress: 100, status: 'completed' },
    noteTexts: ['????????????????', '??????????????????'], flag: null,
    diagnosis: {
      target_exam: '?????', target_score: 126, diagnosis_score: 112, diagnosis_date: '2026-04-05', teacher_comment: '??????????????????',
      points: [{ point_name: '????', priority: 'low', description: '??????', sort_order: 1 }],
    },
    handoutTitle: '??????', replayTitle: '??????', answerTitle: '??????', answerScore: 16,
    calendar: [{ title: '??? ? ???', date: '2026-04-05', start: '08:00', end: '09:00', type: 'class', link: 'https://meeting.example.com/wu-1' }],
    chatMessages: [
      ['student', '???', '?????????????'],
      ['teacher', '???', '????????????'],
    ],
    submissions: [
      { id: 'pdf_s7_1', reviewType: '????', checkpoint: '????', deadline: '2026-04-09 15:00:00', priority: 'normal', submittedNormal: 1, fileName: '???-????.pdf', graded: 0, score: null, feedback: null, gradedAt: null, createdAt: '2026-04-07 09:30:00' },
    ],
    notification: { type: 'system', title: '??????', content: '??????????????????', related_type: 'course', related_id: '????', scheduled_at: '2026-04-07 10:00:00' },
    outlineItems: [
      { type: 'listen', content: '????????', sort_order: 1 },
      { type: 'write', content: '???????', sort_order: 2 },
    ],
  },
  {
    key: 's8', openid: 'dev_openid_008', phone: '13800000008', name: '???', status: 'leave', grade: '2026?', subject: '??', coachKey: 'lin', diagnosisKey: 'wang', managerKey: 'chen', principalKey: 'liu', lastSession: '2026-03-30',
    profile: { gender: 'female', hometown: '??', exam_status: '???', exam_date: '2026-07-20', education: '??', major: '???', avatar_url: '' },
    course: { name: '?????', progress: 12, status: 'in_progress' },
    noteTexts: ['????????????????', '??????????????????'], flag: null,
    diagnosis: {
      target_exam: '?????', target_score: 121, diagnosis_score: 90, diagnosis_date: '2026-03-30', teacher_comment: '?????????????????????',
      points: [{ point_name: '?????', priority: 'high', description: '???????', sort_order: 1 }],
    },
    handoutTitle: '???????', replayTitle: '???????', answerTitle: '?????', answerScore: 9,
    calendar: [{ title: '??? ? ???', date: '2026-03-30', start: '10:30', end: '11:30', type: 'class', link: null }],
    chatMessages: [
      ['student', '???', '??????????'],
      ['teacher', '???', '??????????????????????'],
    ],
    submissions: [],
    notification: { type: 'leave', title: '???????', content: '????????????????????', related_type: 'leave_request', related_id: 's8_leave_1', scheduled_at: '2026-04-07 09:20:00' },
    leaveRequest: { pointName: '?????', stepName: 'Day 3 ? ????', days: 3, reason: '?????????????????', status: 'approved' },
    outlineItems: [
      { type: 'listen', content: '?????????', sort_order: 1 },
      { type: 'write', content: '??????????', sort_order: 2 },
    ],
  },
]

function ensureSamplePdf() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
  if (fs.existsSync(SAMPLE_PDF_PATH)) return
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 1 /Kids [3 0 R] >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 60 >>
stream
BT
/F1 18 Tf
72 760 Td
(Seed PDF Placeholder) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000063 00000 n 
0000000122 00000 n 
0000000248 00000 n 
0000000358 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
428
%%EOF`
  fs.writeFileSync(SAMPLE_PDF_PATH, pdf, 'utf8')
}

async function getId(conn, table, whereColumn, whereValue) {
  const [[row]] = await conn.query(
    'SELECT id FROM ' + table + ' WHERE ' + whereColumn + ' = ? LIMIT 1',
    [whereValue],
  )
  return row?.id ?? null
}

async function getOrCreateCourse(conn, course) {
  const existingId = await getId(conn, 'courses', 'name', course.name)
  if (existingId) {
    await conn.query('UPDATE courses SET subject = ?, description = ?, price = ?, is_active = 1 WHERE id = ?', [course.subject, course.description, course.price, existingId])
    return existingId
  }
  const [result] = await conn.query('INSERT INTO courses (name, subject, description, price) VALUES (?, ?, ?, ?)', [course.name, course.subject, course.description, course.price])
  return result.insertId
}

async function deleteForStudents(conn, studentIds) {
  if (studentIds.length === 0) return
  const marks = studentIds.map(() => '?').join(', ')
  await conn.query('DELETE oi FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM orders WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE cm FROM chat_messages cm JOIN chat_rooms cr ON cm.room_id = cr.id WHERE cr.student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM chat_rooms WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE tr FROM task_resources tr JOIN study_tasks st ON tr.task_id = st.id JOIN study_days sd ON st.study_day_id = sd.id WHERE sd.student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE st FROM study_tasks st JOIN study_days sd ON st.study_day_id = sd.id WHERE sd.student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM study_days WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM study_sessions WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE ri FROM review_items ri JOIN reviews r ON ri.review_id = r.id WHERE r.student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM reviews WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM outline_items WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE drp FROM diagnosis_report_points drp JOIN diagnosis_reports dr ON drp.report_id = dr.id WHERE dr.student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM diagnosis_reports WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM pdf_submissions WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM student_submissions WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM notifications WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM leave_requests WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM student_notes WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM student_flags WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM calendar_events WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM student_team_members WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM teacher_students WHERE student_id IN (' + marks + ')', studentIds)
  await conn.query('DELETE FROM student_courses WHERE student_id IN (' + marks + ')', studentIds)
}

async function insertStudyPlan(conn, studentId, courseId, studentName, courseName) {
  const dayPlan = [
    { day: 1, status: 'completed', tasks: [{ name: courseName + ' ? ???', type: 'live', duration: 60, completed: 1, resources: [] }] },
    { day: 2, status: 'completed', tasks: [{ name: courseName + ' ? ???', type: 'video', duration: 45, completed: 1, resources: [
      { resource_type: 'pdf', phase: 'pre', title: studentName + '-' + courseName + '-??', url: '/uploads/' + SAMPLE_PDF_NAME, video_id: null },
      { resource_type: 'video', phase: 'main', title: courseName + ' ????', url: null, video_id: 'video_' + studentId + '_theory' },
    ] }] },
    { day: 3, status: 'completed', tasks: [{ name: courseName + ' ? ???', type: 'live', duration: 60, completed: 1, resources: [] }] },
    { day: 4, status: 'in_progress', tasks: [
      { name: courseName + ' ? ??? 1', type: 'practice', duration: 40, completed: 1, resources: [] },
      { name: courseName + ' ? ????', type: 'video', duration: 20, completed: 0, resources: [{ resource_type: 'video', phase: 'post', title: courseName + ' ??', url: null, video_id: 'video_' + studentId + '_analysis' }] },
    ] },
    { day: 5, status: 'pending', tasks: [{ name: courseName + ' ? ??? 2', type: 'practice', duration: 45, completed: 0, resources: [] }] },
    { day: 6, status: 'pending', tasks: [{ name: courseName + ' ? ????', type: 'submit', duration: 20, completed: 0, resources: [] }] },
    { day: 7, status: 'pending', tasks: [{ name: courseName + ' ? ????', type: 'exam', duration: 60, completed: 0, resources: [{ resource_type: 'pdf', phase: 'pre', title: courseName + ' ?????', url: '/uploads/' + SAMPLE_PDF_NAME, video_id: null }] }] },
  ]

  for (const day of dayPlan) {
    await conn.query('INSERT INTO study_days (student_id, course_id, day_number, status) VALUES (?, ?, ?, ?)', [studentId, courseId, day.day, day.status])
    const [[studyDay]] = await conn.query('SELECT id FROM study_days WHERE student_id = ? AND course_id = ? AND day_number = ?', [studentId, courseId, day.day])
    for (let index = 0; index < day.tasks.length; index += 1) {
      const task = day.tasks[index]
      const [taskResult] = await conn.query('INSERT INTO study_tasks (study_day_id, name, type, duration_min, completed, sort_order) VALUES (?, ?, ?, ?, ?, ?)', [studyDay.id, task.name, task.type, task.duration, task.completed, index])
      for (let resourceIndex = 0; resourceIndex < task.resources.length; resourceIndex += 1) {
        const resource = task.resources[resourceIndex]
        await conn.query('INSERT INTO task_resources (task_id, resource_type, phase, title, url, video_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', [taskResult.insertId, resource.resource_type, resource.phase, resource.title, resource.url, resource.video_id, resourceIndex])
      }
    }
  }
}

async function seed() {
  execFileSync(process.execPath, [path.join(__dirname, 'init.js')], {
    stdio: 'inherit',
    env: process.env,
  })

  ensureSamplePdf()
  const conn = await mysql.createConnection(getDbConfig())
  console.log('????????????...')
  const passwordHash = await bcrypt.hash('123456', 10)
  const teacherIds = {}

  for (const teacher of teachers) {
    await conn.query('INSERT INTO teachers (name, email, password_hash, title) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), title = VALUES(title)', [teacher.name, teacher.email, passwordHash, teacher.title])
    teacherIds[teacher.key] = await getId(conn, 'teachers', 'email', teacher.email)
  }

  const studentIds = {}
  for (const student of students) {
    await conn.query('INSERT INTO students (openid, phone, name, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), name = VALUES(name), status = VALUES(status)', [student.openid, student.phone, student.name, student.status])
    const studentId = await getId(conn, 'students', 'openid', student.openid)
    studentIds[student.key] = studentId
    await conn.query(
      'INSERT INTO student_profiles (student_id, gender, grade, hometown, exam_status, exam_date, education, major, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE gender = VALUES(gender), grade = VALUES(grade), hometown = VALUES(hometown), exam_status = VALUES(exam_status), exam_date = VALUES(exam_date), education = VALUES(education), major = VALUES(major), avatar_url = VALUES(avatar_url)',
      [studentId, student.profile.gender, student.grade, student.profile.hometown, student.profile.exam_status, student.profile.exam_date, student.profile.education, student.profile.major, student.profile.avatar_url],
    )
  }

  await deleteForStudents(conn, Object.values(studentIds))

  const courseIds = {}
  for (const course of courseCatalog) courseIds[course.name] = await getOrCreateCourse(conn, course)

  for (const student of students) {
    const studentId = studentIds[student.key]
    const coachId = teacherIds[student.coachKey]
    const diagnosisId = teacherIds[student.diagnosisKey]
    const managerId = teacherIds[student.managerKey]
    const principalId = teacherIds[student.principalKey]
    const courseId = courseIds[student.course.name]

    await conn.query('INSERT INTO teacher_students (teacher_id, student_id, subject, grade) VALUES (?, ?, ?, ?)', [teacherIds.li, studentId, student.subject, student.grade])

    const teamMembers = [[coachId, 'coach'], [diagnosisId, 'diagnosis'], [managerId, 'manager'], [principalId, 'principal']]
    for (const [teacherId, role] of teamMembers) {
      await conn.query('INSERT INTO student_team_members (student_id, teacher_id, role, status) VALUES (?, ?, ?, ?)', [studentId, teacherId, role, 'assigned'])
    }

    await conn.query('INSERT INTO student_courses (student_id, course_id, progress, status) VALUES (?, ?, ?, ?)', [studentId, courseId, student.course.progress, student.course.status])
    await insertStudyPlan(conn, studentId, courseId, student.name, student.course.name)

    for (const noteText of student.noteTexts) {
      const authorName = teachers.find((item) => item.key === student.coachKey)?.name ?? '??'
      await conn.query('INSERT INTO student_notes (teacher_id, student_id, content, author) VALUES (?, ?, ?, ?)', [teacherIds.li, studentId, noteText, authorName])
    }

    if (student.flag) {
      await conn.query('INSERT INTO student_flags (teacher_id, student_id, flagged, reason, severity) VALUES (?, ?, ?, ?, ?)', [teacherIds.li, studentId, student.flag.flagged, student.flag.reason, student.flag.severity])
    }

    await conn.query('INSERT INTO diagnosis_reports (student_id, teacher_id, target_exam, target_score, diagnosis_score, score_gap, diagnosis_date, teacher_comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [studentId, diagnosisId, student.diagnosis.target_exam, student.diagnosis.target_score, student.diagnosis.diagnosis_score, student.diagnosis.target_score - student.diagnosis.diagnosis_score, student.diagnosis.diagnosis_date, student.diagnosis.teacher_comment])
    const [[report]] = await conn.query('SELECT id FROM diagnosis_reports WHERE student_id = ? ORDER BY id DESC LIMIT 1', [studentId])
    for (const point of student.diagnosis.points) {
      await conn.query('INSERT INTO diagnosis_report_points (report_id, course_id, point_name, priority, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)', [report.id, courseId, point.point_name, point.priority, point.description, point.sort_order])
    }

    await conn.query('INSERT INTO reviews (student_id, teacher_id, course_id, target_score, gained_score, feedback) VALUES (?, ?, ?, ?, ?, ?)', [studentId, coachId, courseId, 20, student.answerScore, student.course.name + ' ????????'])
    const [[review]] = await conn.query('SELECT id FROM reviews WHERE student_id = ? ORDER BY id DESC LIMIT 1', [studentId])
    await conn.query('INSERT INTO review_items (review_id, type, content, completed, sort_order) VALUES (?, ?, ?, ?, ?)', [review.id, 'listen', student.replayTitle + ' ??', 1, 1])
    await conn.query('INSERT INTO review_items (review_id, type, content, completed, sort_order) VALUES (?, ?, ?, ?, ?)', [review.id, 'write', student.answerTitle + ' ??', 0, 2])

    for (const item of student.outlineItems) {
      await conn.query('INSERT INTO outline_items (student_id, course_id, type, content, completed, sort_order) VALUES (?, ?, ?, ?, ?, ?)', [studentId, courseId, item.type, item.content, 0, item.sort_order])
    }

    const [orderResult] = await conn.query('INSERT INTO orders (student_id, total_amount, status, paid_at) VALUES (?, ?, ?, NOW())', [studentId, 1080, 'paid'])
    await conn.query('INSERT INTO order_items (order_id, course_id, course_name_snapshot, price) VALUES (?, ?, ?, ?)', [orderResult.insertId, courseId, student.course.name, 1080])

    for (const event of student.calendar) {
      await conn.query('INSERT INTO calendar_events (teacher_id, student_id, title, date, start_time, end_time, type, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [teacherIds.li, studentId, event.title, event.date, event.start, event.end, event.type, event.link])
    }

    const [roomResult] = await conn.query('INSERT INTO chat_rooms (teacher_id, student_id) VALUES (?, ?)', [teacherIds.li, studentId])
    for (const [senderType, senderName, content] of student.chatMessages) {
      const senderId = senderType === 'teacher' ? coachId : studentId
      await conn.query('INSERT INTO chat_messages (room_id, sender_type, sender_id, sender_name, content, type) VALUES (?, ?, ?, ?, ?, ?)', [roomResult.insertId, senderType, senderId, senderName, content, 'text'])
    }

    for (const submission of student.submissions) {
      await conn.query('INSERT INTO pdf_submissions (id, student_id, student_name, review_type, checkpoint, deadline, priority, submitted_normal, file_name, stored_file, graded, score, feedback, graded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [submission.id, studentId, student.name, submission.reviewType, submission.checkpoint, submission.deadline, submission.priority, submission.submittedNormal, submission.fileName, SAMPLE_PDF_NAME, submission.graded, submission.score, submission.feedback, submission.gradedAt, submission.createdAt])
    }

    await conn.query('INSERT INTO notifications (student_id, type, title, content, related_type, related_id, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [studentId, student.notification.type, student.notification.title, student.notification.content, student.notification.related_type, student.notification.related_id, student.notification.scheduled_at])

    if (student.leaveRequest) {
      await conn.query('INSERT INTO leave_requests (student_id, type, course_id, point_name, step_name, days, reason, status, reviewed_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())', [studentId, 'single', courseId, student.leaveRequest.pointName, student.leaveRequest.stepName, student.leaveRequest.days, student.leaveRequest.reason, student.leaveRequest.status, managerId])
    }

    await conn.query('INSERT INTO study_sessions (student_id, course_id, session_type, status, started_at, ended_at, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)', [studentId, courseId, 'lesson', 'completed', student.lastSession + ' 19:00:00', student.lastSession + ' 20:00:00', 3600])
  }

  console.log('\n测试数据写入完成。')
  console.log('教师登录：li@test.com / 123456')
  console.log('学生 dev-login：' + students.map((student) => studentIds[student.key] + '(' + student.name + ')').join('，'))
  console.log('示例 PDF：' + SAMPLE_PDF_PATH)
  await conn.end()
}

seed().catch((err) => {
  console.error('写入失败：', err.message)
  process.exit(1)
})
