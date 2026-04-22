const CHECKPOINT_NAME_ALIASES = [
  ['英语提分冲刺班', '要点不全不准'],
  ['英语阅读精练班', '提炼转述困难'],
  ['数学压轴突破班', '对策推导困难'],
  ['数学基础巩固班', '公文结构不清'],
  ['语文写作提升班', '作文立意不准'],
  ['阅读定位', '要点不全不准'],
  ['阅读理解', '要点不全不准'],
  ['主旨题', '提炼转述困难'],
  ['阅读专项', '提炼转述困难'],
  ['数列综合', '对策推导困难'],
  ['数学压轴突破', '对策推导困难'],
  ['函数讨论', '分析结构不清'],
  ['书面表达', '作文表达不畅'],
  ['议论文结构', '作文论证不清'],
  ['函数基础', '公文结构不清'],
  ['计算规范', '作文表达不畅'],
]

function normalizeCheckpointName(value) {
  const source = String(value || '').trim()
  if (!source) return ''
  return CHECKPOINT_NAME_ALIASES.reduce((result, [from, to]) => result.replaceAll(from, to), source)
}

module.exports = { CHECKPOINT_NAME_ALIASES, normalizeCheckpointName }
