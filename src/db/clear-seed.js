const mysql = require('mysql2/promise')
const { getDbConfig } = require('../config/env')

const SEED_OPENIDS = [
  'dev_openid_001',
  'dev_openid_002',
  'dev_openid_003',
  'dev_openid_004',
  'dev_openid_005',
  'dev_openid_006',
  'dev_openid_007',
  'dev_openid_008',
]

const SEED_TEACHER_EMAILS = [
  'li@test.com',
  'wang@test.com',
  'chen@test.com',
  'lin@test.com',
  'liu@test.com',
]

async function clearSeed() {
  const conn = await mysql.createConnection(getDbConfig())

  // --- 清除种子学生 ---
  const [studentRows] = await conn.query(
    'SELECT id FROM students WHERE openid IN (?)',
    [SEED_OPENIDS],
  )
  const studentIds = studentRows.map((r) => r.id)

  if (studentIds.length > 0) {
    const m = studentIds.map(() => '?').join(',')
    await conn.query(`DELETE oi FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM orders WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE cm FROM chat_messages cm JOIN chat_rooms cr ON cm.room_id = cr.id WHERE cr.student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM chat_rooms WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE tr FROM task_resources tr JOIN study_tasks st ON tr.task_id = st.id JOIN study_days sd ON st.study_day_id = sd.id WHERE sd.student_id IN (${m})`, studentIds)
    await conn.query(`DELETE st FROM study_tasks st JOIN study_days sd ON st.study_day_id = sd.id WHERE sd.student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM study_days WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM study_sessions WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE ri FROM review_items ri JOIN reviews r ON ri.review_id = r.id WHERE r.student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM reviews WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM review_point_scores WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM study_time_stats WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM outline_items WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE drp FROM diagnosis_report_points drp JOIN diagnosis_reports dr ON drp.report_id = dr.id WHERE dr.student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM diagnosis_reports WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM pdf_submissions WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_submissions WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM notifications WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_mailbox_messages WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_complaints WHERE student_id IN (${m})`, studentIds)
    try {
      await conn.query(`DELETE FROM mailbox_messages WHERE student_id IN (${m})`, studentIds)
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err
    }
    await conn.query(`DELETE FROM leave_requests WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_notes WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_flags WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM practice_assignment_tasks WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM lesson_materials WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM calendar_events WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_team_members WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM teacher_students WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_courses WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM student_profiles WHERE student_id IN (${m})`, studentIds)
    await conn.query(`DELETE FROM students WHERE id IN (${m})`, studentIds)
    console.log(`已删除 ${studentIds.length} 个种子学生`)
  } else {
    console.log('未找到种子学生，跳过')
  }

  // --- 清除种子老师 ---
  const [teacherRows] = await conn.query(
    'SELECT id FROM teachers WHERE email IN (?)',
    [SEED_TEACHER_EMAILS],
  )
  const teacherIds = teacherRows.map((r) => r.id)

  if (teacherIds.length > 0) {
    const m = teacherIds.map(() => '?').join(',')
    await conn.query(`DELETE FROM calendar_events WHERE teacher_id IN (${m}) AND student_id IS NULL`, teacherIds)
    await conn.query(`DELETE FROM teachers WHERE id IN (${m})`, teacherIds)
    console.log(`已删除 ${teacherIds.length} 个种子老师`)
  } else {
    console.log('未找到种子老师，跳过')
  }

  console.log('种子数据清除完毕')
  await conn.end()
}

clearSeed().catch((err) => {
  console.error('清除失败:', err.message)
  process.exit(1)
})
