const mysql = require('mysql2/promise')
const { getDbConfig } = require('./env')

const pool = mysql.createPool({
  ...getDbConfig(),
  waitForConnections: true,
  connectionLimit: 20,
  charset: 'utf8mb4'
})

module.exports = pool
