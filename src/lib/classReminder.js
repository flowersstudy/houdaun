const pool = require('../config/db')
const { sendClassReminder, sendDeadlineReminder } = require('./wxSubscribe')

async function runClassReminderCheck() {
  let conn
  try {
    conn = await pool.getConnection()

    // 查询15分钟后开始的课（14~16分钟窗口，容忍定时器漂移）
    const [events] = await conn.query(`
      SELECT
        e.id          AS event_id,
        e.title,
        e.date,
        e.start_time,
        e.link,
        e.student_id,
        s.openid,
        s.name        AS student_name
      FROM calendar_events e
      JOIN students s ON s.id = e.student_id
      WHERE e.type = 'class'
        AND e.student_id IS NOT NULL
        AND TIMESTAMPDIFF(MINUTE, NOW(), TIMESTAMP(e.date, e.start_time)) BETWEEN 14 AND 16
    `)

    for (const event of events) {
      const [existing] = await conn.query(
        `SELECT id FROM notifications
         WHERE related_type = 'calendar_event'
           AND related_id = ?
           AND type = 'class'
         LIMIT 1`,
        [String(event.event_id)]
      )
      if (existing.length > 0) continue

      const dateStr = event.date instanceof Date
        ? event.date.toISOString().slice(0, 10)
        : String(event.date).slice(0, 10)
      const scheduledAt = new Date(`${dateStr}T${event.start_time}`)

      await conn.query(
        `INSERT INTO notifications
           (student_id, type, title, content, related_type, related_id, scheduled_at)
         VALUES (?, 'class', ?, ?, 'calendar_event', ?, ?)`,
        [
          event.student_id,
          `课堂提醒：${String(event.title || '即将开始').slice(0, 15)}`,
          '您的课堂将在15分钟后开始，请做好准备。',
          String(event.event_id),
          scheduledAt,
        ]
      )

      if (event.openid) {
        sendClassReminder(event.openid, {
          studentName: event.student_name,
          title: event.title,
          date: event.date,
          startTime: event.start_time,
          link: event.link,
        }).catch((err) => {
          console.error(`[classReminder] 微信通知失败 event=${event.event_id}:`, err.message)
        })
      }

      console.log(`[classReminder] 开课提醒 student=${event.student_id} event=${event.event_id}`)
    }
  } catch (err) {
    console.error('[classReminder] 开课扫描失败:', err.message)
  } finally {
    if (conn) conn.release()
  }
}

async function runDeadlineReminderCheck() {
  let conn
  try {
    conn = await pool.getConnection()

    // 查询截止时间在23~25小时后、尚未提交的作业
    const [submissions] = await conn.query(`
      SELECT
        p.id          AS submission_id,
        p.student_id,
        p.checkpoint,
        p.deadline,
        s.openid,
        s.name        AS student_name
      FROM pdf_submissions p
      JOIN students s ON s.id = p.student_id
      WHERE p.graded = 0
        AND p.deadline IS NOT NULL
        AND p.deadline != ''
        AND TIMESTAMPDIFF(MINUTE, NOW(), STR_TO_DATE(p.deadline, '%Y-%m-%d %H:%i:%s')) BETWEEN 1380 AND 1500
    `)

    for (const sub of submissions) {
      const [existing] = await conn.query(
        `SELECT id FROM notifications
         WHERE related_type = 'submission_deadline'
           AND related_id = ?
           AND type = 'homework'
         LIMIT 1`,
        [String(sub.submission_id)]
      )
      if (existing.length > 0) continue

      await conn.query(
        `INSERT INTO notifications
           (student_id, type, title, content, related_type, related_id)
         VALUES (?, 'homework', ?, ?, 'submission_deadline', ?)`,
        [
          sub.student_id,
          `作业提醒：${String(sub.checkpoint || '作业').slice(0, 15)}`,
          '作业将在24小时后截止，请及时提交。',
          String(sub.submission_id),
        ]
      )

      if (sub.openid) {
        sendDeadlineReminder(sub.openid, {
          studentName: sub.student_name,
          checkpoint: sub.checkpoint,
          deadline: sub.deadline,
        }).catch((err) => {
          console.error(`[deadlineReminder] 微信通知失败 submission=${sub.submission_id}:`, err.message)
        })
      }

      console.log(`[deadlineReminder] 作业提醒 student=${sub.student_id} submission=${sub.submission_id}`)
    }
  } catch (err) {
    console.error('[deadlineReminder] 作业扫描失败:', err.message)
  } finally {
    if (conn) conn.release()
  }
}

function startClassReminderScheduler() {
  console.log('[classReminder] 提醒调度器已启动（每分钟扫描）')
  runClassReminderCheck()
  runDeadlineReminderCheck()
  setInterval(() => {
    runClassReminderCheck()
    runDeadlineReminderCheck()
  }, 60 * 1000)
}

module.exports = { startClassReminderScheduler }


async function runClassReminderCheck() {
  let conn
  try {
    conn = await pool.getConnection()

    // 查询15分钟后开始的课（14~16分钟窗口，容忍定时器漂移）
    const [events] = await conn.query(`
      SELECT
        e.id          AS event_id,
        e.title,
        e.date,
        e.start_time,
        e.link,
        e.student_id,
        s.openid,
        s.name        AS student_name
      FROM calendar_events e
      JOIN students s ON s.id = e.student_id
      WHERE e.type = 'class'
        AND e.student_id IS NOT NULL
        AND TIMESTAMPDIFF(MINUTE, NOW(), TIMESTAMP(e.date, e.start_time)) BETWEEN 14 AND 16
    `)

    for (const event of events) {
      // 去重：同一事件只发一次
      const [existing] = await conn.query(
        `SELECT id FROM notifications
         WHERE related_type = 'calendar_event'
           AND related_id = ?
           AND type = 'class'
         LIMIT 1`,
        [String(event.event_id)]
      )
      if (existing.length > 0) continue

      const dateStr = event.date instanceof Date
        ? event.date.toISOString().slice(0, 10)
        : String(event.date).slice(0, 10)
      const scheduledAt = new Date(`${dateStr}T${event.start_time}`)

      // 插入站内通知
      await conn.query(
        `INSERT INTO notifications
           (student_id, type, title, content, related_type, related_id, scheduled_at)
         VALUES (?, 'class', ?, ?, 'calendar_event', ?, ?)`,
        [
          event.student_id,
          `课堂提醒：${String(event.title || '即将开始').slice(0, 15)}`,
          '您的课堂将在15分钟后开始，请做好准备。',
          String(event.event_id),
          scheduledAt,
        ]
      )

      // 发送微信订阅消息（失败不影响主流程）
      if (event.openid) {
        sendClassReminder(event.openid, {
          studentName: event.student_name,
          title: event.title,
          date: event.date,
          startTime: event.start_time,
          link: event.link,
        }).catch((err) => {
          console.error(`[classReminder] 微信通知失败 event=${event.event_id}:`, err.message)
        })
      }

      console.log(`[classReminder] 已提醒 student=${event.student_id} event=${event.event_id}`)
    }
  } catch (err) {
    console.error('[classReminder] 扫描失败:', err.message)
  } finally {
    if (conn) conn.release()
  }
}

function startClassReminderScheduler() {
  console.log('[classReminder] 课堂提醒调度器已启动（每分钟扫描）')
  runClassReminderCheck()
  setInterval(runClassReminderCheck, 60 * 1000)
}

module.exports = { startClassReminderScheduler }
