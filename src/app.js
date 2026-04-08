const express = require('express')
const cors = require('cors')
require('dotenv').config()

const app = express()

app.use(cors())
app.use(express.json())

app.use('/api/auth',        require('./routes/auth'))
app.use('/api/teacher',    require('./routes/teacher'))
app.use('/api/student',    require('./routes/student'))
app.use('/api/chat',       require('./routes/chat'))
app.use('/api/submissions', require('./routes/submissions'))

app.get('/health', (_, res) => res.json({ status: 'ok' }))

module.exports = app
