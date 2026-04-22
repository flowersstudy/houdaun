// 一次性脚本：插入暮雨老师和清风老师
// 用法：node scripts/add-teachers.js
const bcrypt = require('bcryptjs')
const mysql = require('mysql2/promise')
const { getDbConfig, getDbName } = require('../src/config/env')

async function main() {
  const conn = await mysql.createConnection({ ...getDbConfig() })
  const passwordHash = await bcrypt.hash('123456', 10)

  const teachers = [
    { name: '暮雨老师', email: 'muyu@1v1.buzhi.com', title: '带教老师' },
    { name: '清风老师', email: 'qingfeng@1v1.buzhi.com', title: '带教老师' },
  ]

  for (const t of teachers) {
    await conn.query(
      'INSERT INTO teachers (name, email, password_hash, title) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), title = VALUES(title)',
      [t.name, t.email, passwordHash, t.title],
    )
    console.log(`✓ ${t.name} 已插入/更新`)
  }

  await conn.end()
  console.log('完成')
}

main().catch((e) => { console.error(e); process.exit(1) })
