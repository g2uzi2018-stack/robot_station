# robot_station

一个用于机器人遥操作控制的公开项目。当前阶段完成协议、控制台 UI、Web 网关和人员管理；机器人真机侧由其他程序按照 ZRCP/1 协议实现。

## 开发环境

kuang@119.45.181.86:6021
密钥 file://C:\Users\kuang\.ssh\jetson_192_168_3_8_ed25519
路径 /home/kuang/workspace/robot_station

本地 Windows 工作区只用于拉取远端提交。密钥文件不会提交到仓库。

## 当前结构

- `doc/机器人控制台通信协议.md`：ZRCP/1 协议设计稿。
- `doc/robot_console_v0.3.html`：原始离线 UI 原型。
- `apps/web/public/`：服务器提供的登录、人员管理和控制台页面。
- `apps/server/`：Fastify Web 网关、会话、人员管理和机器人 TCP 桥接。
- `packages/protocol/`：共享消息类型、JSON 校验和 TCP 长度分帧。
- `deploy/`：Docker 部署文件。

## 运行

```bash
cp .env.example .env
npm install
npm run dev
```

首次启动前必须在 `.env` 设置 `ADMIN_PASSWORD`，密码至少 12 位。开发模式默认使用 Mock Robot；接入真机时设置 `ROBOT_MODE=tcp`、`ROBOT_HOST`、`ROBOT_PORT` 和 `ROBOT_TOKEN`。

## 角色

- `admin`：人员、机器人配置和审计管理。
- `operator`：申请控制权并执行操作。
- `viewer`：只读查看。

生产部署时应在反向代理启用 HTTPS，并限制服务器到机器人端口的网络访问。网页不会直接连接机器人 TCP。

## 边界

本项目不实现 IK、运动学、CAN、电机驱动、碰撞检测、实体急停或机器人端独立看门狗。控制安全和最终运动执行由机器人端程序负责；桥接层只负责认证、协议转换、状态和请求转发。
