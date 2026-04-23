const pool = require('../config/db')
const { sendClassReminder } = require('./wxSubscribe')

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
