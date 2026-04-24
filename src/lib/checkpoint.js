const ALL_CHECKPOINTS = [
  '要点不全不准',
  '提炼转述困难',
  '对策推导困难',
  '分析结构不清',
  '作文立意不准',
  '作文表达不畅',
  '作文论证不清',
  '公文结构不清',
]

const CHECKPOINT_NAME_ALIASES = []

function normalizeCheckpointName(value) {
  const source = String(value || '').trim()
  if (!source) return ''
  return CHECKPOINT_NAME_ALIASES.reduce((result, [from, to]) => result.replaceAll(from, to), source)
}

module.exports = { ALL_CHECKPOINTS, CHECKPOINT_NAME_ALIASES, normalizeCheckpointName }
