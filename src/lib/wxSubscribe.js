const axios = require('axios')

let _cachedToken = null
let _tokenExpireAt = 0

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpireAt) return _cachedToken

  const { data } = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: {
      grant_type: 'client_credential',
      appid: process.env.WX_APPID,
      secret: process.env.WX_SECRET,
    },
  })

  if (!data.access_token) {
    throw new Error(`获取微信 access_token 失败: ${JSON.stringify(data)}`)
  }

  _cachedToken = data.access_token
  _tokenExpireAt = Date.now() + (data.expires_in - 60) * 1000
  return _cachedToken
}

/**
 * 发送订阅消息（作业批改完成通知）
 * @param {string} openid  学生 openid
 * @param {object} params
 * @param {string} params.studentName  学生姓名
 * @param {string} params.courseName   课程名称
 * @param {string} params.taskTitle    作业标题
 * @param {string|number} params.score 评分（可选）
 * @param {string} params.page         跳转页面路径
 */
async function sendGradeNotification(openid, { studentName, courseName, taskTitle, score, page }) {
  const templateId = process.env.WX_TEMPLATE_GRADE
  if (!templateId) {
    console.warn('[wxSubscribe] WX_SUBSCRIBE_TEMPLATE_ID 未配置，跳过发送')
    return
  }
  if (!openid) {
    console.warn('[wxSubscribe] openid 为空，跳过发送')
    return
  }

  const token = await getAccessToken()
  const now = new Date()
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const data = {
    thing1: { value: String(courseName || '').slice(0, 20) || '作业' },   // 相关课程
    thing2: { value: String(taskTitle || '').slice(0, 20) || '作业' },    // 作业标题
    thing3: { value: score != null ? `${score}分` : '已批改' },           // 作业评分/状态
    time4:  { value: timeStr },                                            // 批改时间
    name5:  { value: String(studentName || '').slice(0, 10) || '同学' },  // 学生姓名
  }

  const { data: result } = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
    {
      touser: openid,
      template_id: templateId,
      page: page || '/pages/results/results',
      data,
    }
  )

  if (result.errcode && result.errcode !== 0) {
    // errcode 43101 = 用户未订阅，属于正常情况，不报错
    if (result.errcode === 43101) {
      console.log(`[wxSubscribe] 用户 ${openid} 未订阅，跳过`)
    } else {
      console.error(`[wxSubscribe] 发送失败:`, result)
    }
  } else {
    console.log(`[wxSubscribe] 已通知 ${openid}`)
  }
}

/**
 * 发送课堂提醒订阅消息（上课前15分钟）
 * @param {string} openid
 * @param {object} params
 * @param {string} params.studentName  学生姓名
 * @param {string} params.title        课堂标题
 * @param {Date|string} params.date    上课日期
 * @param {string} params.startTime    上课时间 HH:MM:SS
 * @param {string} params.link         课堂链接（可选）
 */
async function sendClassReminder(openid, { studentName, title, date, startTime, link }) {
  const templateId = process.env.WX_TEMPLATE_CLASS
  if (!templateId) {
    console.warn('[wxSubscribe] WX_TEMPLATE_CLASS 未配置，跳过发送')
    return
  }
  if (!openid) {
    console.warn('[wxSubscribe] openid 为空，跳过发送')
    return
  }

  const token = await getAccessToken()

  const dateStr = date instanceof Date
    ? date.toISOString().slice(0, 10)
    : String(date).slice(0, 10)
  const timeStr = String(startTime || '').slice(0, 5)

  const data = {
    thing1: { value: String(title || '课堂').slice(0, 20) },
    time2:  { value: `${dateStr} ${timeStr}` },
    name3:  { value: String(studentName || '同学').slice(0, 10) },
    thing4: { value: link ? '点击查看课堂链接' : '请准时参加' },
  }

  const { data: result } = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
    {
      touser: openid,
      template_id: templateId,
      page: '/pages/schedule/schedule',
      data,
    }
  )

  if (result.errcode && result.errcode !== 0) {
    if (result.errcode === 43101) {
      console.log(`[wxSubscribe] 用户 ${openid} 未订阅课堂提醒，跳过`)
    } else {
      console.error(`[wxSubscribe] 课堂提醒发送失败:`, result)
    }
  } else {
    console.log(`[wxSubscribe] 课堂提醒已通知 ${openid}`)
  }
}

module.exports = { sendGradeNotification, sendClassReminder }
