async function rebalanceStudentCourseStatuses(executor, studentId) {
  const [rows] = await executor.query(
    `SELECT id, status
     FROM student_courses
     WHERE student_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [studentId]
  )

  let activeCourseAssigned = false

  for (const row of rows) {
    const currentStatus = String(row.status || '').trim()
    let nextStatus = currentStatus

    if (currentStatus === 'completed') {
      nextStatus = 'completed'
    } else if (!activeCourseAssigned) {
      nextStatus = 'in_progress'
      activeCourseAssigned = true
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
