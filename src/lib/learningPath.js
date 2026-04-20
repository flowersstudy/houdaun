const STAGE_ORDER = ['diagnose', 'theory', 'training', 'exam', 'report', 'drill']
const THEORY_REPEAT_COUNT = 3

const THEORY_CONFIG_STAGE_KEY = 'theory_config'
const THEORY_CONFIG_TASK_ID = 'assignment_config'

function buildResource(resourceType = '', title = '', url = '', videoId = '') {
  return {
    resourceType,
    title,
    url,
    videoId,
    liveUrl: '',
    replayUrl: '',
    noteUrl: '',
  }
}

function normalizeTheoryLesson(lesson = {}) {
  return {
    id: String(lesson.id || '').trim(),
    title: String(lesson.title || '').trim(),
    scope: String(lesson.scope || '').trim(),
    videoId: String(lesson.videoId || '').trim(),
    preClassUrl: String(lesson.preClassUrl || '').trim(),
    analysisUrl: String(lesson.analysisUrl || '').trim(),
    knowledgeId: String(lesson.knowledgeId || '').trim(),
    knowledgeTitle: String(lesson.knowledgeTitle || '').trim(),
    knowledgeType: String(lesson.knowledgeType || '').trim(),
    noteText: String(lesson.noteText || '').trim(),
  }
}

function getTheoryConfigPayload(stateRows = []) {
  const configRow = stateRows.find((row) => row.stage_key === THEORY_CONFIG_STAGE_KEY && row.task_id === THEORY_CONFIG_TASK_ID)
  if (!configRow) return {}
  return readMeta(configRow.meta_json)
}

function buildDynamicTheoryDefinition(stateRows = []) {
  const payload = getTheoryConfigPayload(stateRows)
  const theoryLessons = Array.isArray(payload.theoryLessons)
    ? payload.theoryLessons
      .map((lesson) => normalizeTheoryLesson(lesson))
      .filter((lesson) => lesson.id || lesson.title || lesson.videoId || lesson.preClassUrl || lesson.analysisUrl)
    : []

  if (!theoryLessons.length) {
    return null
  }

  const groups = theoryLessons.map((lesson, index) => {
    const roundNumber = index + 1
    const roundLabel = `第 ${roundNumber} 轮`
    const titlePrefix = lesson.title || roundLabel
    const lessonContext = {
      roundNumber,
      roundLabel,
      lessonTitle: titlePrefix,
      knowledgeTitle: lesson.knowledgeTitle,
      questionTitle: lesson.noteText || lesson.title || lesson.knowledgeTitle || lesson.scope,
    }

    return {
      title: roundLabel,
      items: [
        {
          id: `theory_round_${roundNumber}_handout`,
          title: '课前讲义',
          desc: `${roundLabel}下载课前讲义 PDF。`,
          actionText: '查看讲义',
          actionType: 'document',
          resource: buildResource('pdf', `${titlePrefix}课前讲义`, lesson.preClassUrl),
        },
        {
          id: `theory_round_${roundNumber}_recorded`,
          title: '理论课',
          desc: `${roundLabel}观看理论课录播，返回后可选星级评价。`,
          actionText: '看录播',
          actionType: 'video',
          secondaryActionText: '找老师',
          secondaryActionType: 'askTeacher',
          resource: buildResource('video', titlePrefix, '', lesson.videoId),
          lessonContext,
        },
        {
          id: `theory_round_${roundNumber}_homework_pdf`,
          title: '课后作业',
          desc: `${roundLabel}下载课后作业 PDF。`,
          actionText: '下载作业',
          actionType: 'document',
          resource: buildResource('pdf', `${titlePrefix}课后作业`, lesson.analysisUrl || lesson.preClassUrl),
        },
        {
          id: `theory_round_${roundNumber}_explain_video`,
          title: '视频讲解',
          desc: `${roundLabel}观看视频讲解，返回后可选星级评价。`,
          actionText: '看讲解',
          actionType: 'video',
          resource: buildResource('video', `${titlePrefix}视频讲解`, '', lesson.videoId),
        },
      ],
    }
  })

  groups.push({
    title: '思维导图',
    items: [
      {
        id: 'theory_mindmap_upload',
        title: '上传思维导图',
        desc: '支持上传 PDF 或照片，可反复重新上传。',
        actionText: '去上传',
        actionType: 'upload',
      },
    ],
  })

  return {
    ...STAGE_DEFINITIONS.theory,
    stageSubtitle: `按老师分配的 ${theoryLessons.length} 节理论课顺序学习，完成后再上传思维导图。`,
    groups,
  }
}

function normalizeAssignmentResourceItem(item = {}) {
  return {
    id: String(item.id || '').trim(),
    slotKey: String(item.slotKey || '').trim(),
    rawTitle: String(item.rawTitle || '').trim(),
    questionTitle: String(item.questionTitle || '').trim(),
    displayTitle: String(item.displayTitle || '').trim(),
    videoId: String(item.videoId || '').trim(),
    preClassUrl: String(item.preClassUrl || '').trim(),
    analysisUrl: String(item.analysisUrl || '').trim(),
    provinceKeys: Array.isArray(item.provinceKeys)
      ? item.provinceKeys.map((key) => String(key || '').trim()).filter(Boolean)
      : [],
  }
}

function resolveAssignmentResourceTitle(item = {}, fallbackTitle = '') {
  return String(item.displayTitle || item.questionTitle || item.rawTitle || fallbackTitle || '').trim()
}

function buildDynamicAssignmentStageItems(stageKey, items = [], label = '') {
  return items.flatMap((item, index) => {
    const itemIndex = index + 1
    const baseTitle = resolveAssignmentResourceTitle(item, `${label}${itemIndex}`)
    const taskPrefix = `${stageKey}_${itemIndex}`

    return [
      {
        id: `${taskPrefix}_reading`,
        title: '?? PDF',
        desc: `???${baseTitle}??? PDF?`,
        actionText: '????',
        actionType: 'document',
        resource: buildResource('pdf', `${baseTitle} ? ?? PDF`, item.preClassUrl),
      },
      {
        id: `${taskPrefix}_video`,
        title: '????',
        desc: `???${baseTitle}??????`,
        actionText: '???',
        actionType: 'video',
        secondaryActionText: '???',
        secondaryActionType: 'askTeacher',
        resource: buildResource('video', `${baseTitle} ? ????`, '', item.videoId),
      },
      {
        id: `${taskPrefix}_analysis`,
        title: '?? PDF',
        desc: `???${baseTitle}??? PDF?`,
        actionText: '????',
        actionType: 'document',
        resource: buildResource('pdf', `${baseTitle} ? ?? PDF`, item.analysisUrl),
      },
    ]
  })
}

function buildDynamicResourceStage(stageKey, stateRows = []) {
  if (!['drill', 'exam'].includes(stageKey)) {
    return null
  }

  const payload = getTheoryConfigPayload(stateRows)
  const sourceItems = stageKey === 'drill' ? payload.practiceItems : payload.examItems
  const items = Array.isArray(sourceItems)
    ? sourceItems
      .map((item) => normalizeAssignmentResourceItem(item))
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

  if (!items.length) {
    return null
  }

  const label = stageKey === 'drill' ? '??' : '??'

  return {
    ...STAGE_DEFINITIONS[stageKey],
    sectionTitle: `${label}??`,
    stageSubtitle: `????????? ${items.length} ?${label}?????`,
    groups: [
      {
        title: `${label}??`,
        items: buildDynamicAssignmentStageItems(stageKey, items, label),
      },
    ],
  }
}

function getStageDefinition(stageKey, stateRows = []) {
  if (stageKey === 'theory') {
    const dynamicDefinition = buildDynamicTheoryDefinition(stateRows)
    if (dynamicDefinition) {
      return dynamicDefinition
    }
  }

  if (stageKey === 'drill' || stageKey === 'exam') {
    const dynamicDefinition = buildDynamicResourceStage(stageKey, stateRows)
    if (dynamicDefinition) {
      return dynamicDefinition
    }
  }

  return STAGE_DEFINITIONS[stageKey] || STAGE_DEFINITIONS.diagnose
}

const DRILL_ITEMS = [
  {
    id: 'drill_question',
    title: '题目',
    desc: '查看当前刷题题目 PDF。',
    actionText: '查看题目',
    actionType: 'document',
  },
  {
    id: 'drill_upload',
    title: '上传作业',
    desc: '上传本次刷题作业，支持 PDF 或图片。',
    actionText: '去上传',
    actionType: 'upload',
  },
  {
    id: 'drill_ai_review',
    title: 'AI批改',
    desc: '提交后进入 AI 批改流程。',
    actionText: '查看批改',
    actionType: 'processing',
  },
  {
    id: 'drill_live',
    title: '去上课',
    desc: '进入直播课链接。',
    actionText: '去上课',
    actionType: 'live',
    secondaryActionText: '去提问',
    secondaryActionType: 'askTeacher',
  },
  {
    id: 'drill_replay',
    title: '去回顾',
    desc: '查看直播课回放链接。',
    actionText: '去回顾',
    actionType: 'replay',
  },
  {
    id: 'drill_qa_summary',
    title: '群内答疑总结',
    desc: '查看群内答疑总结。',
    actionText: '查看总结',
    actionType: 'feedback',
  },
]

function buildTrainingRound(roundNumber) {
  const taskPrefix = `training_round_${roundNumber}`
  return [
    {
      id: `${taskPrefix}_question`,
      title: '题目',
      desc: '查看本题实训题目 PDF。',
      actionText: '查看题目',
      actionType: 'document',
    },
    {
      id: `${taskPrefix}_explain_video`,
      title: '视频讲解',
      desc: '查看 PDF 文档及视频链接，并完成课程星级评价。',
      actionText: '看讲解',
      actionType: 'video',
    },
    {
      id: `${taskPrefix}_homework_upload`,
      title: '上传作业',
      desc: '看完视频讲解后提交本题作业，支持 PDF 或图片。',
      actionText: '去上传',
      actionType: 'upload',
      requireDoneTaskId: `${taskPrefix}_explain_video`,
      blockedToast: '看完视频讲解后才可以上传作业',
    },
    {
      id: `${taskPrefix}_homework_feedback`,
      title: '批改反馈',
      desc: '查看本题作业批改反馈；有疑问可去“找老师”提问。',
      actionText: '查看反馈',
      actionType: 'feedback',
      secondaryActionText: '去提问',
      secondaryActionType: 'askTeacher',
    },
    {
      id: `${taskPrefix}_reflection_upload`,
      title: '学生心得体会',
      desc: '提交本题学习心得体会，支持 PDF 或图片。',
      actionText: '去提交',
      actionType: 'upload',
    },
    {
      id: `${taskPrefix}_reflection_feedback`,
      title: '批改反馈',
      desc: '查看本题心得体会批改反馈。',
      actionText: '查看反馈',
      actionType: 'feedback',
    },
  ]
}

const TRAINING_ROUND_ITEMS = [1, 2, 3].reduce((items, roundNumber) => (
  items.concat(buildTrainingRound(roundNumber))
), [])

function buildTheoryRound(roundNumber) {
  const label = `第 ${roundNumber} 轮`
  return {
    title: label,
    items: [
      { id: `theory_round_${roundNumber}_recorded`, title: '理论课', desc: `${label}观看理论课录播，返回后可选星级评价。`, actionText: '看录播', actionType: 'video', secondaryActionText: '找老师', secondaryActionType: 'askTeacher' },
      { id: `theory_round_${roundNumber}_homework_pdf`, title: '课后作业', desc: `${label}下载课后作业 PDF。`, actionText: '下载作业', actionType: 'document' },
      { id: `theory_round_${roundNumber}_explain_video`, title: '视频讲解', desc: `${label}观看视频讲解，返回后可选星级评价。`, actionText: '看讲解', actionType: 'video' },
    ],
  }
}

const THEORY_ROUND_GROUPS = Array.from({ length: THEORY_REPEAT_COUNT }, (_, index) => (
  buildTheoryRound(index + 1)
))

const STAGE_DEFINITIONS = {
  diagnose: {
    stageKey: 'diagnose',
    stageIndex: '1 / 6',
    stageName: '诊断',
    stageSubtitle: '按顺序完成诊断群、电话沟通、诊断试卷、解析课、1v1诊断、回顾和报告。',
    sectionTitle: '诊断路径',
    groups: [
      {
        title: '诊断路径',
        items: [
          { id: 'diagnose_group', title: '诊断群', desc: '点击加入诊断群，接收老师安排和后续通知。', actionText: '去加群', actionType: 'group' },
          { id: 'diagnose_schedule', title: '电话沟通', desc: '自己选择老师可预约时间，确认当前问题和学习目标。', actionText: '预约时间', actionType: 'schedule' },
          { id: 'diagnose_paper', title: '诊断试卷', desc: '先完成诊断试卷，帮助老师判断当前卡点。', actionText: '查看试卷', actionType: 'document' },
          { id: 'diagnose_analysis_video', title: '听解析课', desc: '查看解析课内容，了解本卡点常见失分原因。', actionText: '去学习', actionType: 'video' },
          { id: 'diagnose_live', title: '1v1诊断：去上课', desc: '进入 1v1 诊断直播课链接。', actionText: '去上课', actionType: 'live' },
          { id: 'diagnose_feedback', title: '课后反馈', desc: '查看老师给你的本次诊断反馈。', actionText: '查看反馈', actionType: 'feedback' },
          { id: 'diagnose_replay', title: '去回顾', desc: '查看直播课回放链接。', actionText: '去回顾', actionType: 'replay' },
          { id: 'diagnose_report', title: '报告', desc: '查看诊断报告和后续学习建议。', actionText: '查看报告', actionType: 'report' },
        ],
      },
    ],
  },
  theory: {
    stageKey: 'theory',
    stageIndex: '2 / 6',
    stageName: '理论',
    stageSubtitle: '按“课前讲义—理论课—课后作业—视频讲解”循环学习多轮，完成后再上传思维导图。',
    sectionTitle: '理论路径',
    groups: [
      {
        title: '课前准备',
        items: [
          { id: 'theory_handout', title: '课前讲义', desc: '下载理论课课前讲义 PDF。', actionText: '查看讲义', actionType: 'document' },
        ],
      },
      ...THEORY_ROUND_GROUPS,
      {
        title: '思维导图',
        items: [
          { id: 'theory_mindmap_upload', title: '上传思维导图', desc: '支持上传 PDF 或照片，可反复重新上传。', actionText: '去上传', actionType: 'upload' },
        ],
      },
    ],
  },
  training: {
    stageKey: 'training',
    stageIndex: '3 / 6',
    stageName: '实训',
    stageSubtitle: '按 3 轮完成“题目、视频讲解、上传作业、批改反馈/去提问、学生心得体会、批改反馈”的实训闭环。',
    sectionTitle: '实训路径',
    groups: [
      {
        title: '实训路径',
        items: [
          { id: 'training_timer', title: '计时器', desc: '设置并开始本次实训计时。', actionType: 'timer' },
          ...TRAINING_ROUND_ITEMS,
        ],
      },
    ],
  },
  exam: {
    stageKey: 'exam',
    stageIndex: '4 / 6',
    stageName: '测试',
    stageSubtitle: '按顺序完成倒计时、题目、上传、讲解、反馈和卡点报告。',
    sectionTitle: '测试路径',
    groups: [
      {
        title: '测试路径',
        items: [
          { id: 'exam_countdown', title: '倒计时显示器', desc: '设置并开始本次测试倒计时。', actionType: 'timer' },
          { id: 'exam_question', title: '题目', desc: '查看当前测试题目 PDF。', actionText: '查看题目', actionType: 'document' },
          { id: 'exam_homework_upload', title: '上传作业', desc: '上传测试作业，支持 PDF 或图片，可重新上传。', actionText: '去上传', actionType: 'upload' },
          { id: 'exam_explain_video', title: '视频讲解', desc: '查看 PDF 文档及视频链接。', actionText: '去学习', actionType: 'video', secondaryActionText: '去提问', secondaryActionType: 'askTeacher' },
          { id: 'exam_feedback', title: '批改反馈', desc: '查看基于作业 PDF 的批改反馈。', actionText: '查看反馈', actionType: 'feedback', secondaryActionText: '去提问', secondaryActionType: 'askTeacher' },
          { id: 'exam_point_report', title: '查看卡点报告', desc: '查看当前卡点测试报告。', actionText: '查看报告', actionType: 'report' },
        ],
      },
    ],
  },
  report: {
    stageKey: 'report',
    stageIndex: '5 / 6',
    stageName: '完成',
    stageSubtitle: '恭喜你完成本次学习。',
    sectionTitle: '学习完成',
    groups: [
      {
        title: '学习完成',
        items: [
          { id: 'report_encourage', title: '恭喜你完成本次学习', desc: '你已经走完了这一阶段的完整训练路径，继续保持复盘和练习节奏，下一次会更稳、更准。', actionText: '我知道了', actionType: 'encourage' },
        ],
      },
    ],
  },
  drill: {
    stageKey: 'drill',
    stageIndex: '6 / 6',
    stageName: '刷题',
    stageSubtitle: '先开启正计时，再按顺序完成题目、上传作业、AI批改、去上课、去回顾、群内答疑总结，最后查看刷题报告总结。',
    sectionTitle: '刷题流程',
    groups: [
      {
        title: '刷题流程',
        items: [
          { id: 'drill_countdown', title: '计时器', desc: '开始本次刷题计时。', actionType: 'timer' },
          ...DRILL_ITEMS,
          { id: 'drill_monthly_report', title: '刷题报告总结', desc: '查看 4 月直播课安排、休息日和注意事项。', actionText: '查看课表', actionType: 'report' },
        ],
      },
    ],
  },
}

function normalizeStatus(status = '') {
  return ['done', 'current', 'pending'].includes(status) ? status : 'done'
}

function readMeta(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function decorateTask(item, taskState = {}) {
  const meta = readMeta(taskState.meta_json)
  return {
    ...item,
    taskId: item.id,
    taskKey: item.id,
    status: taskState.status || 'pending',
    meta,
    resource: meta.resource || item.resource || null,
    secondaryAction: item.secondaryActionText
      ? { label: item.secondaryActionText, actionType: item.secondaryActionType }
      : null,
    uploads: meta.uploads || [],
    appointment: meta.appointment || null,
    result: meta.result || null,
  }
}

function buildStage(stageKey, pointName, stateRows = []) {
  const definition = getStageDefinition(stageKey, stateRows)
  const stateMap = new Map(
    stateRows
      .filter((row) => row.stage_key === definition.stageKey)
      .map((row) => [row.task_id, row])
  )
  let currentFound = false
  let currentTaskId = ''

  const groups = definition.groups.map((group, groupIndex) => ({
    title: group.title,
    groupKey: group.title || `group_${groupIndex + 1}`,
    groupName: group.title,
    items: group.items.map((item) => {
      const taskState = stateMap.get(item.id)
      const storedStatus = taskState ? normalizeStatus(taskState.status) : ''
      let status = storedStatus || 'pending'

      if (!storedStatus && !currentFound) {
        status = 'current'
      }

      if (status === 'current') {
        currentFound = true
        currentTaskId = item.id
      }

      return decorateTask(item, {
        ...taskState,
        status,
      })
    }),
  }))

  groups.forEach((group) => {
    group.tasks = group.items
  })

  const allItems = groups.flatMap((group) => group.items)
  const status = allItems.every((item) => item.status === 'done')
    ? 'done'
    : allItems.some((item) => item.status === 'current')
      ? 'current'
      : 'pending'

  return {
    ...definition,
    pointName,
    currentTaskId,
    status,
    groups,
  }
}

function buildLearningPathPayload(studentId, pointName, stateRows = []) {
  const stages = STAGE_ORDER.map((stageKey) => buildStage(stageKey, pointName, stateRows))
  return {
    studentId: String(studentId),
    pointName,
    updatedAt: new Date().toISOString(),
    stages,
  }
}

function findTaskDefinition(stageKey, taskId, stateRows = []) {
  const definition = getStageDefinition(stageKey, stateRows)
  if (!definition || !taskId) return null

  for (const group of definition.groups) {
    const match = group.items.find((item) => item.id === taskId)
    if (match) return match
  }

  return null
}

function flattenStageTasks(stageKey, stateRows = []) {
  const definition = getStageDefinition(stageKey, stateRows)
  if (!definition) return []

  return definition.groups.flatMap((group) => group.items || [])
}

function getTaskIndex(stageKey, taskId, stateRows = []) {
  return flattenStageTasks(stageKey, stateRows).findIndex((item) => item.id === taskId)
}

function getPreviousTaskIds(stageKey, taskId, stateRows = []) {
  const taskIndex = getTaskIndex(stageKey, taskId, stateRows)
  if (taskIndex <= 0) return []

  return flattenStageTasks(stageKey, stateRows)
    .slice(0, taskIndex)
    .map((item) => item.id)
}

function getFeedbackTaskIdForUploadTask(taskId = '') {
  if (!taskId) return ''

  const fixedMap = {
    exam_homework_upload: 'exam_feedback',
    drill_upload: 'drill_qa_summary',
  }

  if (fixedMap[taskId]) return fixedMap[taskId]

  const trainingMatch = taskId.match(/^training_round_(\d+)_(homework|reflection)_upload$/)
  if (trainingMatch) {
    return `training_round_${trainingMatch[1]}_${trainingMatch[2]}_feedback`
  }

  return ''
}

function getUploadTaskIdForFeedbackTask(taskId = '') {
  if (!taskId) return ''

  const fixedMap = {
    exam_feedback: 'exam_homework_upload',
    drill_qa_summary: 'drill_upload',
  }

  if (fixedMap[taskId]) return fixedMap[taskId]

  const trainingMatch = taskId.match(/^training_round_(\d+)_(homework|reflection)_feedback$/)
  if (trainingMatch) {
    return `training_round_${trainingMatch[1]}_${trainingMatch[2]}_upload`
  }

  return ''
}

function isUploadTask(stageKey, taskId, stateRows = []) {
  const taskDefinition = findTaskDefinition(stageKey, taskId, stateRows)
  return !!(taskDefinition && taskDefinition.actionType === 'upload')
}

function isFeedbackTask(stageKey, taskId, stateRows = []) {
  const taskDefinition = findTaskDefinition(stageKey, taskId, stateRows)
  return !!(taskDefinition && taskDefinition.actionType === 'feedback')
}

module.exports = {
  STAGE_DEFINITIONS,
  STAGE_ORDER,
  buildLearningPathPayload,
  flattenStageTasks,
  getFeedbackTaskIdForUploadTask,
  getPreviousTaskIds,
  getTaskIndex,
  getUploadTaskIdForFeedbackTask,
  findTaskDefinition,
  isFeedbackTask,
  isUploadTask,
  normalizeStatus,
  readMeta,
}
