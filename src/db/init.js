const mysql = require('mysql2/promise')
const { getDbConfig, getDbName } = require('../config/env')

async function init() {
  const conn = await mysql.createConnection({
    ...getDbConfig(false),
    multipleStatements: true,
  })
  const dbName = getDbName()

  console.log('已连接 MySQL，开始初始化数据库...')

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4;`)
  await conn.query(`USE \`${dbName}\`;`)

  const tables = `
    CREATE TABLE IF NOT EXISTS teachers (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(50)  NOT NULL,
      email         VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      title         VARCHAR(100),
      created_at    DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS students (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      openid     VARCHAR(100) UNIQUE,
      account    VARCHAR(50) UNIQUE,
      phone      VARCHAR(20) UNIQUE,
      password_hash VARCHAR(255),
      name       VARCHAR(50)  NOT NULL DEFAULT '新学员',
      status     ENUM('normal','abnormal','new','leave') DEFAULT 'new',
      created_at DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS student_profiles (
      student_id   INT PRIMARY KEY,
      gender       ENUM('male','female','other') DEFAULT 'other',
      grade        VARCHAR(20),
      hometown     VARCHAR(100),
      exam_status  VARCHAR(50),
      exam_date    DATE,
      education    VARCHAR(50),
      major        VARCHAR(100),
      avatar_url   VARCHAR(500),
      updated_at   DATETIME DEFAULT NOW() ON UPDATE NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS student_avatar_presets (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      avatar_key  VARCHAR(50) NOT NULL UNIQUE,
      label       VARCHAR(50) NOT NULL,
      avatar_url  VARCHAR(500) NOT NULL,
      sort_order  INT DEFAULT 0,
      created_at  DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS teacher_students (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NOT NULL,
      student_id INT NOT NULL,
      subject    VARCHAR(50),
      grade      VARCHAR(20),
      created_at DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_ts (teacher_id, student_id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS student_team_members (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      student_id  INT NOT NULL,
      teacher_id  INT NOT NULL,
      role        ENUM('coach','diagnosis','manager','principal') NOT NULL,
      status      ENUM('assigned','pending','inactive') DEFAULT 'assigned',
      assigned_at DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_student_role (student_id, role),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id)
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NOT NULL,
      student_id INT,
      title      VARCHAR(100),
      date       DATE NOT NULL,
      start_time TIME,
      end_time   TIME,
      type        ENUM('class','meeting','other') DEFAULT 'class',
      course_type ENUM('diagnose','consensus','correction') DEFAULT NULL,
      link        VARCHAR(500),
      replay_link VARCHAR(500),
      created_at  DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_event_slot (teacher_id, student_id, title, date, start_time, end_time, type),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS student_notes (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NOT NULL,
      student_id INT NOT NULL,
      content    TEXT NOT NULL,
      author     VARCHAR(50),
      created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS student_flags (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NOT NULL,
      student_id INT NOT NULL,
      flagged    TINYINT(1) DEFAULT 0,
      reason     VARCHAR(100),
      severity   ENUM('high','medium','low') DEFAULT 'medium',
      updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
      UNIQUE KEY uq_flag (teacher_id, student_id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS student_submissions (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NOT NULL,
      student_id INT NOT NULL,
      content    TEXT,
      graded     TINYINT(1) DEFAULT 0,
      score      INT,
      feedback   TEXT,
      created_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS courses (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      subject     VARCHAR(50),
      description TEXT,
      price       DECIMAL(10,2) DEFAULT 1080.00,
      is_active   TINYINT(1) DEFAULT 1,
      created_at  DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS student_courses (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      course_id  INT NOT NULL,
      progress   INT DEFAULT 0,
      status     ENUM('in_progress','completed','failed') DEFAULT 'in_progress',
      created_at DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_sc (student_id, course_id),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id)  REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS study_days (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      course_id  INT NOT NULL,
      day_number INT NOT NULL,
      status     ENUM('pending','in_progress','completed') DEFAULT 'pending',
      UNIQUE KEY uq_study_day (student_id, course_id, day_number),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id)  REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS study_tasks (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      study_day_id INT NOT NULL,
      name         VARCHAR(100),
      description  VARCHAR(255),
      duration_min INT DEFAULT 0,
      type         ENUM('video','practice','submit','review','exam','live','other') DEFAULT 'other',
      completed    TINYINT(1) DEFAULT 0,
      sort_order   INT DEFAULT 0,
      UNIQUE KEY uq_task_sort (study_day_id, sort_order),
      FOREIGN KEY (study_day_id) REFERENCES study_days(id)
    );

    CREATE TABLE IF NOT EXISTS task_resources (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      task_id       INT NOT NULL,
      resource_type ENUM('pdf','video','link','file') DEFAULT 'pdf',
      phase         ENUM('pre','main','post') DEFAULT 'main',
      title         VARCHAR(255) NOT NULL,
      url           VARCHAR(500),
      video_id      VARCHAR(100),
      sort_order    INT DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES study_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS study_sessions (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      student_id    INT NOT NULL,
      course_id     INT,
      study_task_id INT,
      point_name    VARCHAR(100),
      session_type  ENUM('lesson','video','practice','review','exam','other') DEFAULT 'other',
      status        ENUM('started','completed','aborted') DEFAULT 'completed',
      started_at    DATETIME NOT NULL,
      ended_at      DATETIME,
      duration_sec  INT DEFAULT 0,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id) REFERENCES courses(id),
      FOREIGN KEY (study_task_id) REFERENCES study_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS student_learning_path_tasks (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      student_id      INT NOT NULL,
      point_name      VARCHAR(100) NOT NULL,
      stage_key       VARCHAR(30) NOT NULL,
      task_id         VARCHAR(100) NOT NULL,
      is_done         TINYINT(1) DEFAULT 0,
      meta_json       JSON,
      updated_by_role ENUM('student','teacher') DEFAULT 'student',
      updated_by_id   INT,
      created_at      DATETIME DEFAULT NOW(),
      updated_at      DATETIME DEFAULT NOW() ON UPDATE NOW(),
      UNIQUE KEY uq_learning_path_task (student_id, point_name, stage_key, task_id),
      KEY idx_learning_path_student_point (student_id, point_name),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS chat_rooms (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NOT NULL,
      student_id INT NOT NULL,
      created_at DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_room (teacher_id, student_id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      room_id     INT NOT NULL,
      sender_type ENUM('teacher','student') NOT NULL,
      sender_id   INT NOT NULL,
      sender_name VARCHAR(50),
      content     TEXT NOT NULL,
      type        ENUM('text','image','file','audio') DEFAULT 'text',
      reply_to_id INT,
      created_at  DATETIME DEFAULT NOW(),
      FOREIGN KEY (room_id) REFERENCES chat_rooms(id)
    );

    CREATE TABLE IF NOT EXISTS diagnosis_reports (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      student_id      INT NOT NULL,
      teacher_id      INT,
      target_exam     VARCHAR(100),
      target_score    INT,
      diagnosis_score INT,
      score_gap       INT,
      diagnosis_date  DATE,
      teacher_comment TEXT,
      created_at      DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id)
    );

    CREATE TABLE IF NOT EXISTS diagnosis_report_points (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      report_id   INT NOT NULL,
      course_id   INT,
      point_name  VARCHAR(100),
      priority    ENUM('high','medium','low') DEFAULT 'medium',
      description TEXT,
      sort_order  INT DEFAULT 0,
      FOREIGN KEY (report_id) REFERENCES diagnosis_reports(id),
      FOREIGN KEY (course_id) REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      student_id   INT NOT NULL,
      teacher_id   INT,
      course_id    INT,
      target_score INT,
      gained_score INT DEFAULT 0,
      feedback     TEXT,
      created_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS review_items (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      review_id  INT NOT NULL,
      type       ENUM('listen','write') NOT NULL,
      content    VARCHAR(255),
      completed  TINYINT(1) DEFAULT 0,
      sort_order INT DEFAULT 0,
      FOREIGN KEY (review_id) REFERENCES reviews(id)
    );

    CREATE TABLE IF NOT EXISTS review_point_scores (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      student_id   INT NOT NULL,
      point_name   VARCHAR(100) NOT NULL,
      current_rate INT,
      target_rate  INT,
      source_type  ENUM('diagnosis','monthly_review') DEFAULT 'diagnosis',
      sort_order   INT DEFAULT 0,
      created_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS study_time_stats (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      student_id   INT NOT NULL,
      period_key   VARCHAR(50) NOT NULL,
      period_label VARCHAR(50) NOT NULL,
      hours        DECIMAL(10,2) DEFAULT 0,
      cycle_type   ENUM('day','week','month') DEFAULT 'week',
      sort_order   INT DEFAULT 0,
      created_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS outline_items (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      course_id  INT NOT NULL,
      type       ENUM('listen','write') NOT NULL,
      content    VARCHAR(255),
      completed  TINYINT(1) DEFAULT 0,
      sort_order INT DEFAULT 0,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id) REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS contact_notes (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id  INT NOT NULL,
      contact_id  VARCHAR(100) NOT NULL,
      author_name VARCHAR(50),
      text        TEXT NOT NULL,
      created_at  DATETIME DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lesson_materials (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id        INT NOT NULL,
      student_id        INT,
      calendar_event_id INT NOT NULL,
      material_type     ENUM('handout','replay') NOT NULL,
      title             VARCHAR(255),
      url               VARCHAR(500),
      file_name         VARCHAR(255),
      stored_file       VARCHAR(255),
      created_at        DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_lesson_material (calendar_event_id, material_type),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id)
    );

    CREATE TABLE IF NOT EXISTS practice_assignment_tasks (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id  INT NOT NULL,
      student_id  INT NOT NULL,
      checkpoint  VARCHAR(120),
      detail      VARCHAR(255),
      status      ENUM('pending','assigned') DEFAULT 'pending',
      created_at  DATETIME DEFAULT NOW(),
      assigned_at DATETIME,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS pdf_submissions (
      id               VARCHAR(36) PRIMARY KEY,
      student_id       INT,
      student_name     VARCHAR(50),
      review_type      VARCHAR(50),
      checkpoint       VARCHAR(100),
      deadline         VARCHAR(50),
      priority         ENUM('urgent','normal','low') DEFAULT 'normal',
      submitted_normal TINYINT(1) DEFAULT 1,
      file_name        VARCHAR(255),
      stored_file      VARCHAR(255),
      graded           TINYINT(1) DEFAULT 0,
      score            INT,
      feedback         TEXT,
      graded_at        DATETIME,
      reviewed_file_name   VARCHAR(255),
      reviewed_stored_file VARCHAR(255),
      point_name       VARCHAR(100),
      stage_key        VARCHAR(50),
      task_id          VARCHAR(100),
      feedback_task_id VARCHAR(100),
      created_at       DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS checkpoint_theory_library (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      checkpoint_name     VARCHAR(100) NOT NULL,
      knowledge_point     VARCHAR(255) NOT NULL,
      knowledge_type      ENUM('required','optional') DEFAULT 'required',
      learning_status_raw VARCHAR(255),
      province_tags_json  JSON,
      course_status       VARCHAR(100),
      theory_title        VARCHAR(255) NOT NULL,
      video_id            VARCHAR(255),
      pre_class_url       VARCHAR(500),
      analysis_url        VARCHAR(500),
      note_text           TEXT,
      source_sheet        VARCHAR(100),
      source_row          INT,
      sort_order          INT DEFAULT 0,
      created_at          DATETIME DEFAULT NOW(),
      updated_at          DATETIME DEFAULT NOW() ON UPDATE NOW(),
      KEY idx_checkpoint_theory_checkpoint (checkpoint_name),
      KEY idx_checkpoint_theory_knowledge (checkpoint_name, knowledge_point)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      student_id   INT NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      status       ENUM('pending','paid','cancelled','refunded') DEFAULT 'pending',
      paid_at      DATETIME,
      created_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      order_id             INT NOT NULL,
      course_id            INT NOT NULL,
      course_name_snapshot VARCHAR(100) NOT NULL,
      price                DECIMAL(10,2) NOT NULL,
      UNIQUE KEY uq_order_course (order_id, course_id),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (course_id) REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      student_id   INT NOT NULL,
      type         ENUM('class','exam','homework','review','leave','system') DEFAULT 'system',
      title        VARCHAR(120) NOT NULL,
      content      VARCHAR(255),
      related_type VARCHAR(50),
      related_id   VARCHAR(50),
      scheduled_at DATETIME,
      is_read      TINYINT(1) DEFAULT 0,
      read_at      DATETIME,
      created_at   DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );


    CREATE TABLE IF NOT EXISTS student_complaints (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      student_id            INT NOT NULL,
      created_by_teacher_id INT NOT NULL,
      demand                TEXT NOT NULL,
      reason                TEXT NOT NULL,
      suggestion            TEXT NOT NULL,
      resolvers_json        TEXT,
      deadline              DATE NOT NULL,
      extra_note            TEXT,
      attachments_json      LONGTEXT,
      status                ENUM('pending','resolved') DEFAULT 'pending',
      resolved_note         TEXT,
      resolved_at           DATETIME,
      created_at            DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (created_by_teacher_id) REFERENCES teachers(id)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      student_id    INT NOT NULL,
      type          ENUM('single','all') DEFAULT 'single',
      course_id     INT,
      point_name    VARCHAR(100),
      step_name     VARCHAR(100),
      days          INT DEFAULT 1,
      reason        TEXT,
      status        ENUM('pending','approved','rejected') DEFAULT 'pending',
      reviewed_by   INT,
      reject_reason VARCHAR(255),
      approved_at   DATETIME,
      created_at    DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id) REFERENCES courses(id),
      FOREIGN KEY (reviewed_by) REFERENCES teachers(id)
    );

    CREATE TABLE IF NOT EXISTS student_mailbox_messages (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      student_id  INT NOT NULL,
      category    VARCHAR(50) NOT NULL,
      content     TEXT NOT NULL,
      anonymous   TINYINT(1) DEFAULT 1,
      status      ENUM('pending','read','replied','closed') DEFAULT 'pending',
      replied_by  INT,
      reply_text  TEXT,
      replied_at  DATETIME,
      created_at  DATETIME DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (replied_by) REFERENCES teachers(id)
    );

    CREATE TABLE IF NOT EXISTS student_feedback_messages (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      student_id       INT NOT NULL,
      source           ENUM('recorded_lesson','find_teacher') NOT NULL,
      title            VARCHAR(120),
      point_name       VARCHAR(100),
      course_id        INT,
      content          TEXT,
      attachments_json LONGTEXT,
      meta_json        LONGTEXT,
      status           ENUM('pending','read') DEFAULT 'pending',
      reviewed_by      INT,
      reviewed_at      DATETIME,
      created_at       DATETIME DEFAULT NOW(),
      updated_at       DATETIME DEFAULT NOW() ON UPDATE NOW(),
      INDEX idx_feedback_student (student_id),
      INDEX idx_feedback_status (status),
      INDEX idx_feedback_created (created_at),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (course_id) REFERENCES courses(id),
      FOREIGN KEY (reviewed_by) REFERENCES teachers(id)
    );
  `

  const statements = tables
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

  for (const sql of statements) {
    await conn.query(sql)
    const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)
    if (match) console.log(`✓ 表 ${match[1]} 已就绪`)
  }

  console.log('\n检查并补充旧表字段...')

  const alters = [
    ['teachers', "ADD COLUMN title VARCHAR(100) AFTER password_hash"],
    ['students', 'MODIFY COLUMN openid VARCHAR(100) NULL'],
    ['students', 'ADD COLUMN account VARCHAR(50) UNIQUE AFTER openid'],
    ['students', "ADD COLUMN phone VARCHAR(20) UNIQUE AFTER account"],
    ['students', 'ADD COLUMN password_hash VARCHAR(255) AFTER phone'],
    ['courses', 'ADD COLUMN price DECIMAL(10,2) DEFAULT 1080.00 AFTER description'],
    ['study_tasks', "MODIFY COLUMN type ENUM('video','practice','submit','review','exam','live','other') DEFAULT 'other'"],
    ['study_sessions', 'ADD COLUMN point_name VARCHAR(100) AFTER study_task_id'],
    ['study_time_stats', "MODIFY COLUMN cycle_type ENUM('day','week','month') DEFAULT 'week'"],
    ['leave_requests', 'ADD COLUMN reviewed_by INT AFTER status'],
    ['leave_requests', 'ADD COLUMN reject_reason VARCHAR(255) AFTER reviewed_by'],
    ['pdf_submissions', 'ADD COLUMN score INT AFTER graded'],
    ['pdf_submissions', 'ADD COLUMN feedback TEXT AFTER score'],
    ['pdf_submissions', 'ADD COLUMN graded_at DATETIME AFTER feedback'],
    ['pdf_submissions', 'ADD COLUMN reviewed_file_name VARCHAR(255) AFTER graded_at'],
    ['pdf_submissions', 'ADD COLUMN reviewed_stored_file VARCHAR(255) AFTER reviewed_file_name'],
    ['pdf_submissions', 'ADD COLUMN point_name VARCHAR(100) AFTER graded_at'],
    ['pdf_submissions', 'ADD COLUMN stage_key VARCHAR(50) AFTER point_name'],
    ['pdf_submissions', 'ADD COLUMN task_id VARCHAR(100) AFTER stage_key'],
    ['pdf_submissions', 'ADD COLUMN feedback_task_id VARCHAR(100) AFTER task_id'],
    ['student_flags', 'ADD COLUMN reason VARCHAR(100) AFTER flagged'],
    ['student_flags', "ADD COLUMN severity ENUM('high','medium','low') DEFAULT 'medium' AFTER reason"],
    ['calendar_events', 'ADD CONSTRAINT fk_ce_student FOREIGN KEY (student_id) REFERENCES students(id)'],
    ['calendar_events', "ADD COLUMN course_type ENUM('diagnose','consensus','correction') DEFAULT NULL"],
    ['calendar_events', 'ADD COLUMN replay_link VARCHAR(500) DEFAULT NULL'],
    ['leave_requests', 'ADD CONSTRAINT fk_leave_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES teachers(id)'],
  ]

  // 单独开通诊断课/刷题课记录表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS student_special_courses (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      student_id   INT NOT NULL,
      type         ENUM('diagnose','drill') NOT NULL,
      granted_by   INT NOT NULL,
      created_at   DATETIME DEFAULT NOW(),
      UNIQUE KEY uq_student_type (student_id, type),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (granted_by) REFERENCES teachers(id)
    );
  `)

  for (const [table, clause] of alters) {
    try {
      await conn.query(`ALTER TABLE ${table} ${clause}`)
      console.log(`✓ ${table}: ${clause.split(' ').slice(0, 3).join(' ')}`)
    } catch (e) {
      if (
        e.code === 'ER_DUP_FIELDNAME' ||
        e.code === 'ER_FK_DUP_NAME' ||
        e.code === 'ER_DUP_KEYNAME' ||
        e.errno === 1060 ||
        e.errno === 1061 ||
        e.errno === 1826
      ) {
        continue
      }
      console.warn(`  跳过 ${table}: ${e.message}`)
    }
  }

  await conn.end()
  console.log('\n数据库初始化完成。')
}

init().catch((err) => {
  console.error('初始化失败：', err.message)
  process.exit(1)
})
