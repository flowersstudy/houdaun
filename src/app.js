const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const app = express()

const DEFAULT_UPLOADS_DIR = path.join(__dirname, '../uploads')
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : DEFAULT_UPLOADS_DIR
const PUBLIC_DIR = path.join(__dirname, '../public')

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

app.use(cors())
app.use(express.json({ limit: '20mb' }))
app.use('/uploads', express.static(UPLOADS_DIR, {
  fallthrough: false,
  index: false,
}))

app.get('/polyv/player', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'polyv-player.html'))
})

app.use('/api/auth',        require('./routes/auth'))
app.use('/api/teacher',    require('./routes/teacher'))
app.use('/api/student',    require('./routes/student'))
app.use('/api/chat',       require('./routes/chat'))
app.use('/api/submissions', require('./routes/submissions'))

app.get('/health', (_, res) => res.json({ status: 'ok' }))

module.exports = app
