async function rebalanceStudentCourseStatuses(executor, studentId) {
  const [rows] = await executor.query(
    `SELECT id, status
     FROM student_courses
     WHERE student_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [studentId]
  )

  let hasActiveCourse = false

  for (const row of rows) {
    const currentStatus = String(row.status || '').trim()
    let nextStatus = currentStatus

    if (currentStatus === 'completed') {
      nextStatus = 'completed'
    } else if (currentStatus === 'failed' || currentStatus === 'aborted') {
      nextStatus = currentStatus
    } else if (!hasActiveCourse) {
      nextStatus = 'in_progress'
      hasActiveCourse = true
    } else {
      nextStatus = 'pending'
    }

    if (nextStatus !== currentStatus) {
      await executor.query(
        'UPDATE student_courses SET status = ? WHERE id = ?',
        [nextStatus, row.id]
      )
    }
  }
}

module.exports = {
  rebalanceStudentCourseStatuses,
}
