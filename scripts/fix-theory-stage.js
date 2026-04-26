/**
 * 修复旧版理论课数据
 * 把 task_id 不匹配新代码的 theory 阶段记录全部清掉
 * 执行：node scripts/fix-theory-stage.js
 */
require('dotenv').config()
const pool = require('../src/config/db')

// 新版代码里 theory 阶段所有合法的 task_id 前缀
const VALID_PREFIXES = [
  'theory_consensus_',
  'theory_mindmap_',
  'theory_correction_',
  'theory_round_',
]

function isValidTaskId(taskId = '') {
  return VALID_PREFIXES.some((prefix) => taskId.startsWith(prefix))
}

async function main() {
  const conn = await pool.getConnection()
  try {
    // 查出所有 theory 阶段的记录
    const [rows] = await conn.query(
      `SELECT id, student_id, task_id FROM learning_path_tasks WHERE stage_key = 'theory'`
    )

    const invalidRows = rows.filter((row) => !isValidTaskId(row.task_id))
    const affectedStudentIds = [...new Set(invalidRows.map((r) => r.student_id))]

    console.log(`共 ${rows.length} 条 theory 记录，其中 ${invalidRows.length} 条 task_id 不合法`)
    console.log(`涉及学生 ${affectedStudentIds.length} 人：`, affectedStudentIds)

    if (invalidRows.length === 0) {
      console.log('无需修复')
      return
    }

    // 把这些学生的 theory 阶段全部清掉（包括合法的，让他们从头开始）
    const [result] = await conn.query(
      `DELETE FROM learning_path_tasks WHERE stage_key = 'theory' AND student_id IN (?)`,
      [affectedStudentIds]
    )

    console.log(`已删除 ${result.affectedRows} 条记录，受影响学生将从 1v1共识 重新开始`)
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
