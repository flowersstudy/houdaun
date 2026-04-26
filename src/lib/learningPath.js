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

  const roundGroups = theoryLessons.map((lesson, index) => {
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

    const items = []

    if (lesson.preClassUrl) {
      items.push({
        id: `theory_round_${roundNumber}_handout`,
        title: '课前讲义',
        desc: `${roundLabel}下载课前讲义 PDF。`,
        actionText: '查看讲义',
        actionType: 'document',
        resource: buildResource('pdf', `${titlePrefix}课前讲义`, lesson.preClassUrl),
      })
    }

    if (lesson.videoId) {
      items.push({
        id: `theory_round_${roundNumber}_recorded`,
        title: '理论课',
        desc: `${roundLabel}观看理论课录播，返回后可选星级评价。`,
        actionText: '看录播',
        actionType: 'video',
        secondaryActionText: '找老师',
        secondaryActionType: 'askTeacher',
        resource: buildResource('video', titlePrefix, '', lesson.videoId),
        lessonContext,
      })
    }

    if (lesson.analysisUrl || lesson.preClassUrl) {
      items.push({
        id: `theory_round_${roundNumber}_homework_pdf`,
        title: '课后作业',
        desc: `${roundLabel}下载课后作业 PDF。`,
        actionText: '下载作业',
        actionType: 'document',
        resource: buildResource('pdf', `${titlePrefix}课后作业`, lesson.analysisUrl || lesson.preClassUrl),
      })
    }

    if (lesson.videoId) {
      items.push({
        id: `theory_round_${roundNumber}_explain_video`,
        title: '视频讲解',
        desc: `${roundLabel}观看视频讲解，返回后可选星级评价。`,
        actionText: '看讲解',
        actionType: 'video',
        resource: buildResource('video', `${titlePrefix}视频讲解`, '', lesson.videoId),
      })
    }

    return {
      title: roundLabel,
      items,
    }
  })

  const groups = [
    {
      title: '1v1共识',
      items: [
        { id: 'theory_consensus_live', title: '1v1共识：去上课', desc: '进入 1v1 共识直播课链接。', actionText: '去上课', actionType: 'live' },
        { id: 'theory_consensus_feedback', title: '课后反馈', desc: '完成课后反馈问卷。', actionText: '填写反馈', actionType: 'feedback' },
        { id: 'theory_consensus_replay', title: '去回顾', desc: '查看 1v1 共识直播课回放链接。', actionText: '去回顾', actionType: 'replay' },
        { id: 'theory_consensus_handout', title: '课后讲义', desc: '查看本次共识课课后讲义 PDF。', actionText: '查看讲义', actionType: 'document' },
      ],
    },
    ...roundGroups,
    {
      title: '思维导图',
      items: [
        {
          id: 'theory_mindmap_upload',
          title: '上传思维导图',
          desc: '支持上传 PDF 或照片，可反复重新上传。',
          actionText: '去上传',
          actionType: 'upload',
        },
        {
          id: 'theory_mindmap_feedback',
          title: '老师点评',
          desc: '查看思维导图老师点评。',
          actionText: '查看点评',
          actionType: 'feedback',
        },
      ],
    },
    {
      title: '1v1纠偏',
      items: [
        { id: 'theory_correction_live', title: '1v1纠偏：去上课', desc: '进入 1v1 纠偏直播课链接。', actionText: '去上课', actionType: 'live' },
        { id: 'theory_correction_feedback', title: '课后反馈', desc: '完成课后反馈问卷。', actionText: '填写反馈', actionType: 'feedback' },
        { id: 'theory_correction_replay', title: '去回顾', desc: '查看 1v1 纠偏直播课回放链接。', actionText: '去回顾', actionType: 'replay' },
        { id: 'theory_correction_handout', title: '课后讲义', desc: '查看本次纠偏课课后讲义 PDF。', actionText: '查看讲义', actionType: 'document' },
        { id: 'theory_correction_upload', title: '作业上传', desc: '上传纠偏课后作业。', actionText: '去上传', actionType: 'upload' },
        { id: 'theory_correction_review', title: '批改反馈', desc: '查看纠偏课作业批改反馈。', actionText: '查看反馈', actionType: 'feedback' },
      ],
    },
  ]

  return {
    ...STAGE_DEFINITIONS.theory,
    stageSubtitle: `按"1v1共识—理论课（${theoryLessons.length}轮）—思维导图—1v1纠偏"顺序完成理论阶段学习。`,
    groups,
  }
}

function normalizeAssignmentResourceItem(item = {}) {
  return {
    id: String(item.id || '').trim(),
    kind: String(item.kind || '').trim(),
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
    const nextItems = []

    if (item.preClassUrl) {
      nextItems.push({
        id: `${taskPrefix}_reading`,
        title: '?? PDF',
        desc: `???${baseTitle}??? PDF?`,
        actionText: '????',
        actionType: 'document',
        resource: buildResource('pdf', `${baseTitle} ? ?? PDF`, item.preClassUrl),
      })
    }

    if (item.videoId) {
      nextItems.push({
        id: `${taskPrefix}_video`,
        title: '????',
        desc: `???${baseTitle}??????`,
        actionText: '???',
        actionType: 'video',
        secondaryActionText: '???',
        secondaryActionType: 'askTeacher',
        resource: buildResource('video', `${baseTitle} ? ????`, '', item.videoId),
      })
    }

    if (item.analysisUrl) {
      nextItems.push({
        id: `${taskPrefix}_analysis`,
        title: '?? PDF',
        desc: `???${baseTitle}??? PDF?`,
        actionText: '????',
        actionType: 'document',
        resource: buildResource('pdf', `${baseTitle} ? ?? PDF`, item.analysisUrl),
      })
    }

    return nextItems
  })
}

function buildDynamicExamSequenceItems(taskPrefix, resourceItem = {}, options = {}) {
  const {
    includeCountdown = false,
    fixedTaskIds = false,
    sequenceLabel = '',
  } = options
  const baseTitle = resolveAssignmentResourceTitle(resourceItem, sequenceLabel || '测试')
  const questionTaskId = fixedTaskIds ? 'exam_question' : `${taskPrefix}_question`
  const uploadTaskId = fixedTaskIds ? 'exam_homework_upload' : `${taskPrefix}_homework_upload`
  const explainTaskId = fixedTaskIds ? 'exam_explain_video' : `${taskPrefix}_explain_video`
  const feedbackTaskId = fixedTaskIds ? 'exam_feedback' : `${taskPrefix}_feedback`
  const reportTaskId = fixedTaskIds ? 'exam_point_report' : `${taskPrefix}_point_report`
  const items = []

  if (includeCountdown) {
    items.push({
      id: 'exam_countdown',
      title: '倒计时显示器',
      desc: '设置并开始本次测试倒计时。',
      actionType: 'timer',
    })
  }

  items.push({
    id: questionTaskId,
    title: sequenceLabel ? `${sequenceLabel}题目` : '题目',
    desc: `查看${baseTitle}题目 PDF。`,
    actionText: '查看题目',
    actionType: 'document',
    ...(resourceItem.preClassUrl
      ? { resource: buildResource('pdf', `${baseTitle}题目`, resourceItem.preClassUrl) }
      : {}),
  })

  items.push({
    id: uploadTaskId,
    title: sequenceLabel ? `${sequenceLabel}上传作业` : '上传作业',
    desc: `上传${baseTitle}作业，支持 PDF 或图片，可重新上传。`,
    actionText: '去上传',
    actionType: 'upload',
  })

  items.push({
    id: explainTaskId,
    title: sequenceLabel ? `${sequenceLabel}视频讲解` : '视频讲解',
    desc: `查看${baseTitle}视频讲解。`,
    actionText: '去学习',
    actionType: 'video',
    secondaryActionText: '去提问',
    secondaryActionType: 'askTeacher',
    ...(resourceItem.videoId
      ? { resource: buildResource('video', `${baseTitle}视频讲解`, '', resourceItem.videoId) }
      : {}),
  })

  items.push({
    id: feedbackTaskId,
    title: sequenceLabel ? `${sequenceLabel}批改反馈` : '批改反馈',
    desc: `查看${baseTitle}批改反馈。`,
    actionText: '查看反馈',
    actionType: 'feedback',
    secondaryActionText: '去提问',
    secondaryActionType: 'askTeacher',
  })

  items.push({
    id: reportTaskId,
    title: sequenceLabel ? `${sequenceLabel}卡点报告` : '查看卡点报告',
    desc: `查看${baseTitle}对应的卡点报告。`,
    actionText: '查看报告',
    actionType: 'report',
  })

  return items
}

function buildDynamicExamStage(stateRows = []) {
  const payload = getTheoryConfigPayload(stateRows)
  const normalizeItems = (sourceItems = []) => (
    Array.isArray(sourceItems)
      ? sourceItems
      .map((item) => normalizeAssignmentResourceItem(item))
      .filter((item) => (
        item.id
        || item.kind
        || item.displayTitle
        || item.questionTitle
        || item.rawTitle
        || item.videoId
        || item.preClassUrl
        || item.analysisUrl
      ))
      : []
  )

  const examItems = normalizeItems(payload.examItems)
  const remedialItems = normalizeItems(payload.remedialItems)

  if (!examItems.length && !remedialItems.length) {
    return null
  }

  const primaryExamItem = examItems[0] || remedialItems[0] || null
  const extraExamItems = examItems.length > 1 ? examItems.slice(1) : []
  const extraRemedialItems = primaryExamItem && examItems.length === 0 ? remedialItems.slice(1) : remedialItems
  const items = primaryExamItem
    ? buildDynamicExamSequenceItems('exam', primaryExamItem, {
        includeCountdown: true,
        fixedTaskIds: true,
      })
    : [{ id: 'exam_countdown', title: '倒计时显示器', desc: '设置并开始本次测试倒计时。', actionType: 'timer' }]

  extraExamItems.forEach((item, index) => {
    items.push(...buildDynamicExamSequenceItems(`exam_round_${index + 2}`, item, {
      sequenceLabel: `加测${index + 1}·`,
    }))
  })

  extraRemedialItems.forEach((item, index) => {
    items.push(...buildDynamicExamSequenceItems(`exam_remedial_${index + 1}`, item, {
      sequenceLabel: `补考${index + 1}·`,
    }))
  })

  return {
    ...STAGE_DEFINITIONS.exam,
    stageSubtitle: remedialItems.length > 0
      ? `按顺序完成测试任务，并继续完成 ${remedialItems.length} 个补考内容。`
      : STAGE_DEFINITIONS.exam.stageSubtitle,
    groups: [
      {
        title: '测试路径',
        items,
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

  if (stageKey === 'training') {
    const dynamicDefinition = buildDynamicTrainingStage(stateRows)
    if (dynamicDefinition) {
      return dynamicDefinition
    }
  }

  if (stageKey === 'exam') {
    const dynamicDefinition = buildDynamicExamStage(stateRows)
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
    id: 'drill_handout',
    title: '课后讲义',
    desc: '查看本次刷题课课后讲义 PDF。',
    actionText: '查看讲义',
    actionType: 'document',
  },
  {
    id: 'drill_qa_summary',
    title: '群内答疑总结',
    desc: '查看群内答疑总结。',
    actionText: '查看总结',
    actionType: 'feedback',
  },
]

function buildTrainingRound(roundNumber, practiceItem = null) {
  const taskPrefix = `training_round_${roundNumber}`
  const items = [
    {
      id: `${taskPrefix}_question`,
      title: '题目',
      desc: '查看本题实训题目 PDF。',
      actionText: '查看题目',
      actionType: 'document',
      ...(practiceItem && practiceItem.preClassUrl
        ? { resource: buildResource('pdf', practiceItem.displayTitle || practiceItem.questionTitle || '题目', practiceItem.preClassUrl) }
        : {}),
    },
    {
      id: `${taskPrefix}_explain_video`,
      title: '录播课',
      desc: '查看 PDF 文档及视频链接，并完成课程星级评价。',
      actionText: '看录播',
      actionType: 'video',
      ...(practiceItem && practiceItem.videoId
        ? { resource: buildResource('video', practiceItem.displayTitle || practiceItem.questionTitle || '录播课', '', practiceItem.videoId) }
        : {}),
    },
    {
      id: `${taskPrefix}_homework_upload`,
      title: '上传作业',
      desc: '看完录播课后提交本题作业，支持 PDF 或图片。',
      actionText: '去上传',
      actionType: 'upload',
      requireDoneTaskId: `${taskPrefix}_explain_video`,
      blockedToast: '看完录播课后才可以上传作业',
    },
    {
      id: `${taskPrefix}_homework_feedback`,
      title: '批改反馈',
      desc: '查看本题作业批改反馈；有疑问可去”找老师”提问。',
      actionText: '查看反馈',
      actionType: 'feedback',
      secondaryActionText: '去提问',
      secondaryActionType: 'askTeacher',
    },
    {
      id: `${taskPrefix}_analysis`,
      title: '刷题解析',
      desc: '查看本题刷题解析 PDF。',
      actionText: '查看解析',
      actionType: 'document',
      ...(practiceItem && practiceItem.analysisUrl
        ? { resource: buildResource('pdf', practiceItem.displayTitle || practiceItem.questionTitle || '刷题解析', practiceItem.analysisUrl) }
        : {}),
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
  return items
}

const TRAINING_ROUND_ITEMS = [1, 2, 3].reduce((items, roundNumber) => (
  items.concat(buildTrainingRound(roundNumber))
), [])

function buildDynamicTrainingStage(stateRows = []) {
  const payload = getTheoryConfigPayload(stateRows)
  const practiceItems = Array.isArray(payload.practiceItems)
    ? payload.practiceItems
      .map((item) => normalizeAssignmentResourceItem(item))
      .filter((item) => item.id || item.displayTitle || item.questionTitle || item.preClassUrl || item.videoId || item.analysisUrl)
    : []

  if (!practiceItems.length) return null

  const roundItems = practiceItems.flatMap((practiceItem, index) => (
    buildTrainingRound(index + 1, practiceItem)
  ))

  return {
    ...STAGE_DEFINITIONS.training,
    stageSubtitle: `按 ${practiceItems.length} 轮完成”题目、录播课、上传作业、批改反馈、刷题解析、学生心得体会、批改反馈”的实训闭环。`,
    groups: [
      {
        title: '实训路径',
        items: [
          { id: 'training_timer', title: '计时器', desc: '设置并开始本次实训计时。', actionType: 'timer' },
          ...roundItems,
        ],
      },
    ],
  }
}

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
        stageSubtitle: '??????????????????????????????????1v1???????????????',
    sectionTitle: '诊断路径',
    groups: [
      {
        title: '诊断路径',
        items: [
          { id: 'diagnose_group', title: '诊断群', desc: '点击加入诊断群，接收老师安排和后续通知。', actionText: '去加群', actionType: 'group' },
          { id: 'diagnose_schedule', title: '电话沟通', desc: '自己选择老师可预约时间，确认当前问题和学习目标。', actionText: '预约时间', actionType: 'schedule' },
          { id: 'diagnose_paper', title: '诊断试卷', desc: '先完成诊断试卷，帮助老师判断当前卡点。', actionText: '查看试卷', actionType: 'document' },
          { id: 'diagnose_paper_upload', title: '上传试卷', desc: '完成试卷后上传答卷 PDF。', actionText: '上传试卷', actionType: 'upload', requireDoneTaskId: 'diagnose_paper', blockedToast: '请先查看诊断试卷' },
          { id: 'diagnose_analysis_video', title: '听解析课', desc: '查看解析课内容，了解本卡点常见失分原因。', actionText: '去学习', actionType: 'video' },
          { id: 'diagnose_paper_feedback', title: '批改反馈', desc: '查看老师基于试卷给出的批改反馈 PDF。', actionText: '查看反馈', actionType: 'feedback' },
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
    stageSubtitle: '按“1v1共识—理论课（多轮）—思维导图—1v1纠偏”顺序完成理论阶段学习。',
    sectionTitle: '理论路径',
    groups: [
      {
        title: '1v1共识',
        items: [
          { id: 'theory_consensus_live', title: '1v1共识：去上课', desc: '进入 1v1 共识直播课链接。', actionText: '去上课', actionType: 'live' },
          { id: 'theory_consensus_feedback', title: '课后反馈', desc: '完成课后反馈问卷。', actionText: '填写反馈', actionType: 'feedback' },
          { id: 'theory_consensus_replay', title: '去回顾', desc: '查看 1v1 共识直播课回放链接。', actionText: '去回顾', actionType: 'replay' },
          { id: 'theory_consensus_handout', title: '课后笔记', desc: '查看本次共识课的 PDF 笔记。', actionText: '查看笔记', actionType: 'document' },
        ],
      },
      ...THEORY_ROUND_GROUPS,
      {
        title: '思维导图',
        items: [
          { id: 'theory_mindmap_upload', title: '上传思维导图', desc: '支持上传 PDF 或照片，可反复重新上传。', actionText: '去上传', actionType: 'upload' },
          { id: 'theory_mindmap_feedback', title: '老师点评', desc: '查看思维导图老师点评。', actionText: '查看点评', actionType: 'feedback' },
        ],
      },
      {
        title: '1v1纠偏',
        items: [
          { id: 'theory_correction_live', title: '1v1纠偏：去上课', desc: '进入 1v1 纠偏直播课链接。', actionText: '去上课', actionType: 'live' },
          { id: 'theory_correction_feedback', title: '课后反馈', desc: '完成课后反馈问卷。', actionText: '填写反馈', actionType: 'feedback' },
          { id: 'theory_correction_replay', title: '去回顾', desc: '查看 1v1 纠偏直播课回放链接。', actionText: '去回顾', actionType: 'replay' },
          { id: 'theory_correction_handout', title: '课后笔记', desc: '查看本次纠偏课的 PDF 笔记。', actionText: '查看笔记', actionType: 'document' },
          { id: 'theory_correction_upload', title: '作业上传', desc: '上传纠偏课后作业。', actionText: '去上传', actionType: 'upload' },
          { id: 'theory_correction_review', title: '批改反馈', desc: '查看纠偏课作业批改反馈。', actionText: '查看反馈', actionType: 'feedback' },
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
  return ['done', 'current', 'pending'].includes(status) ? status : 'pending'
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
  // 将 meta 中存储的直播/录播链接注入到 resource
  const baseResource = meta.resource || item.resource || null
  let resource = baseResource
  if (meta.liveUrl || meta.replayUrl) {
    resource = {
      ...(baseResource || { resourceType: '', title: '', url: '', videoId: '', liveUrl: '', replayUrl: '', noteUrl: '' }),
      liveUrl: meta.liveUrl || (baseResource && baseResource.liveUrl) || '',
      replayUrl: meta.replayUrl || (baseResource && baseResource.replayUrl) || '',
    }
  }
  return {
    ...item,
    taskId: item.id,
    taskKey: item.id,
    status: taskState.status || 'pending',
    meta,
    resource,
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

function summarizeLearningPathProgress(studentId, pointName, stateRows = []) {
  const stages = STAGE_ORDER.map((stageKey) => buildStage(stageKey, pointName, stateRows))
  const items = stages.flatMap((stage) => stage.groups.flatMap((group) => group.items || []))
  const totalTaskCount = items.length
  const doneTaskCount = items.filter((item) => item.status === 'done').length
  const currentTask = items.find((item) => item.status === 'current') || null
  const progressPercent = totalTaskCount > 0
    ? Math.round((doneTaskCount / totalTaskCount) * 100)
    : 0

  return {
    studentId: String(studentId),
    pointName,
    totalTaskCount,
    doneTaskCount,
    progressPercent,
    currentTaskId: currentTask ? String(currentTask.id || currentTask.taskId || '') : '',
    allDone: totalTaskCount > 0 && doneTaskCount >= totalTaskCount,
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
  if (taskIndex <= 0) {
    const fallbackMap = {
      'diagnose:diagnose_paper_upload': ['diagnose_paper'],
      'theory:theory_correction_upload': [
        'theory_correction_live',
        'theory_correction_feedback',
        'theory_correction_replay',
        'theory_correction_handout',
      ],
    }

    return fallbackMap[`${stageKey}:${taskId}`] || []
  }

  return flattenStageTasks(stageKey, stateRows)
    .slice(0, taskIndex)
    .map((item) => item.id)
}

function getFeedbackTaskIdForUploadTask(taskId = '') {
  if (!taskId) return ''

  const fixedMap = {
    diagnose_paper_upload: 'diagnose_paper_feedback',
    theory_mindmap_upload: 'theory_mindmap_feedback',
    theory_correction_upload: 'theory_correction_review',
    exam_homework_upload: 'exam_feedback',
    drill_upload: 'drill_qa_summary',
  }

  if (fixedMap[taskId]) return fixedMap[taskId]

  const trainingMatch = taskId.match(/^training_round_(\d+)_(homework|reflection)_upload$/)
  if (trainingMatch) {
    return `training_round_${trainingMatch[1]}_${trainingMatch[2]}_feedback`
  }

  const examMatch = taskId.match(/^(exam(?:_round|_remedial)_\d+)_homework_upload$/)
  if (examMatch) {
    return `${examMatch[1]}_feedback`
  }

  return ''
}

function getUploadTaskIdForFeedbackTask(taskId = '') {
  if (!taskId) return ''

  const fixedMap = {
    diagnose_paper_feedback: 'diagnose_paper_upload',
    theory_mindmap_feedback: 'theory_mindmap_upload',
    theory_correction_review: 'theory_correction_upload',
    exam_feedback: 'exam_homework_upload',
    drill_qa_summary: 'drill_upload',
  }

  if (fixedMap[taskId]) return fixedMap[taskId]

  const trainingMatch = taskId.match(/^training_round_(\d+)_(homework|reflection)_feedback$/)
  if (trainingMatch) {
    return `training_round_${trainingMatch[1]}_${trainingMatch[2]}_upload`
  }

  const examMatch = taskId.match(/^(exam(?:_round|_remedial)_\d+)_feedback$/)
  if (examMatch) {
    return `${examMatch[1]}_homework_upload`
  }

  return ''
}

function isUploadTask(stageKey, taskId, stateRows = []) {
  const taskDefinition = findTaskDefinition(stageKey, taskId, stateRows)
  if (!taskDefinition) {
    const fallbackUploadTaskSet = new Set([
      'diagnose:diagnose_paper_upload',
      'theory:theory_correction_upload',
    ])
    return fallbackUploadTaskSet.has(`${stageKey}:${taskId}`)
  }
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
  summarizeLearningPathProgress,
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
