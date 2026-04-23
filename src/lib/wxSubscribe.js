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

module.exports = { sendGradeNotification }
