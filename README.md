# student-teacher backend

师生交互系统后端，基于 `Express + MySQL + WebSocket`。

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 复制环境变量文件

```bash
cp .env.example .env
```

3. 初始化数据库

```bash
npm run init-db
```

4. 写入种子数据

```bash
npm run seed
```

5. 启动服务

```bash
npm start
```

默认端口：`3000`

健康检查：

```text
/health
```

## 环境变量

请在 `.env` 中配置：

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `PORT`
- `WX_APPID`
- `WX_SECRET`

## 注意

- `.env` 已加入 `.gitignore`，不要上传真实密钥
- `uploads/` 和运行日志不会上传到 GitHub
- 部署公网时，数据库连接需要改成公网数据库或云数据库配置
