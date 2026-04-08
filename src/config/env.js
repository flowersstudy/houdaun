require('dotenv').config()

function pick(...keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function getDbName() {
  return pick('DB_NAME', 'MYSQLDATABASE') || 'student_teacher'
}

function getDbConfig(includeDatabase = true) {
  const config = {
    host: pick('DB_HOST', 'MYSQLHOST', 'MYSQLHOSTPUBLIC'),
    port: Number(pick('DB_PORT', 'MYSQLPORT', 'MYSQLPORTPUBLIC')) || 3306,
    user: pick('DB_USER', 'MYSQLUSER'),
    password: pick('DB_PASSWORD', 'MYSQLPASSWORD'),
  }

  if (includeDatabase) {
    config.database = getDbName()
  }

  return config
}

module.exports = {
  getDbConfig,
  getDbName,
}
