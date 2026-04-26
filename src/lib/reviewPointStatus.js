const { ALL_CHECKPOINTS, normalizeCheckpointName } = require('./checkpoint')

const REVIEW_POINT_LIST = ALL_CHECKPOINTS.map((pointName, index) => ({
  id: index + 1,
  pointName,
}))

const REVIEW_POINT_STATUS_PRIORITY = {
  learning: 0,
  completed: 1,
  pending: 2,
  assigned: 2,
  locked: 3,
}

function resolveReviewPointStatus(courseStatus = '', pendingStatus = 'assigned') {
  const safeStatus = String(courseStatus || '').trim()

  if (safeStatus === 'completed') return 'completed'
  if (safeStatus === 'pending' || safeStatus === 'not_started') return pendingStatus
  if (!safeStatus || safeStatus === 'failed' || safeStatus === 'aborted') return 'locked'

  return 'learning'
}

function applyReviewPointStatus(statusMap = {}, pointName = '', nextStatus = 'locked') {
  if (!pointName || !statusMap[pointName]) return

  const currentStatus = statusMap[pointName].status || 'locked'
  if ((REVIEW_POINT_STATUS_PRIORITY[nextStatus] || 99) < (REVIEW_POINT_STATUS_PRIORITY[currentStatus] || 99)) {
    statusMap[pointName].status = nextStatus
  }
}

function buildReviewPointStatuses({ courseRows = [], learningPathRows = [], pendingStatus = 'assigned' } = {}) {
  const statusMap = REVIEW_POINT_LIST.reduce((result, item) => {
    result[item.pointName] = { ...item, status: 'locked' }
    return result
  }, {})

  courseRows.forEach((row) => {
    applyReviewPointStatus(
      statusMap,
      normalizeCheckpointName(row.pointName),
      resolveReviewPointStatus(row.status, pendingStatus),
    )
  })

  learningPathRows.forEach((row) => {
    applyReviewPointStatus(
      statusMap,
      normalizeCheckpointName(row.pointName),
      pendingStatus,
    )
  })

  return REVIEW_POINT_LIST.map((item) => statusMap[item.pointName])
}

module.exports = {
  REVIEW_POINT_LIST,
  REVIEW_POINT_STATUS_PRIORITY,
  applyReviewPointStatus,
  buildReviewPointStatuses,
  resolveReviewPointStatus,
}
