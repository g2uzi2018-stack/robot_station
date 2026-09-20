# robot_station

一个用于机器人遥操作控制的公开项目。当前阶段完成协议、控制台 UI、Web 网关和人员管理；机器人真机侧由其他程序按照 ZRCP/1 协议实现。

## 开发环境

kuang@119.45.181.86:6021
密钥 file://C:\Users\kuang\.ssh\jetson_192_168_3_8_ed25519
路径 /home/kuang/workspace/robot_station

本地 Windows 工作区只用于拉取远端提交。密钥文件不会提交到仓库。

## 当前结构

- `doc/机器人控制台通信协议.md`：ZRCP/1 协议与验收约束。
- `doc/robot_console_v0.3.html`：原始界面设计参考（不参与运行）。
- `apps/web/public/`：服务器提供的登录、人员管理、机器人控制台和实时网关桥接页面。
- `apps/server/`：Fastify Web 网关、会话、人员管理和机器人 TCP 桥接。
- `packages/protocol/`：共享消息类型、JSON 校验和 TCP 长度分帧。
- `deploy/`：Docker 部署文件。

## 运行

```bash
cp .env.example .env
npm install
npm run dev
```

登录后打开 `/console.html` 进入控制台。浏览器只连接 WebSocket `/api/control`，不会获得机器人 TCP 地址、令牌或租约值。控制台只显示机器人端状态和结果，不在浏览器内执行动作。启用控制时后端自动申请并启用 ZRCP 控制租约，松开、停止、页面失焦、隐藏、断开时发送停止请求；机器人最终执行结果仍以 ZRCP 回复、状态和结果事件为准。

WebSocket 意图消息使用 `{web_v:1,type:"intent",id,action,params}`，服务端回 `{web_v:1,type:"ack",id,command,motion_id,ok,code,msg,data}`。`control.enable`、`motion.stop_all` 和断开清理由网关维护每个浏览器连接的租约，浏览器不能自行伪造 `lease_id`。

首次启动前必须在 `.env` 设置 `ADMIN_PASSWORD`，密码至少 12 位。机器人程序提供 TCP 服务端，网页服务按连接设置中的地址、端口和令牌作为 TCP 客户端连接它。连接设置可以保存多个具名目标；开发和联调可使用仓库中的打印接收端。

## 角色

- `admin`：人员、角色、密码、启停和审计管理。
- `operator`：申请控制权并执行操作。
- `viewer`：只读查看。

生产部署时应在反向代理启用 HTTPS，并转发 WebSocket Upgrade；限制网页服务到机器人端口的网络访问。浏览器不会直接连接机器人 TCP，连接配置由网页服务保存并使用。Docker Compose 会持久化 SQLite 数据到 `robot_station_data` 卷；首次启动必须提供随机的 `ADMIN_PASSWORD`。机器人地址、端口和令牌可以通过网页的“连接设置”保存，也可以用环境变量作为启动时的默认连接。

## 边界

本项目不实现 IK、运动学、CAN、电机驱动、碰撞检测、实体急停或机器人端独立看门狗。控制安全和最终运动执行由机器人端程序负责；桥接层只负责认证、协议转换、状态和请求转发。

## 打印接收端

仓库提供了一个只依赖 Python 3 标准库的 ZRCP/1 打印接收端，供联调协议和控制台使用。它不会驱动真实设备，只会校验握手、会话、控制租约、使能、运动保活与停止，并将动作按中文摘要打印到终端。接收端同时维护一份内存中的机器人状态，以约 10 Hz 推送状态反馈，并模拟底座、升降、身体俯仰、腰部、双臂、夹爪和头部的变化；目标移动完成或动作停止时也会发送结果消息。控制心跳和链路保活仍会在协议层正常处理，但不会刷屏。

在服务器上启动：

```bash
python3 tools/print_robot_receiver.py --host 0.0.0.0 --port 19001 --token test-token
```

然后让网页服务连接它（也可以在网页“连接设置”中保存这组参数）：

```bash
ROBOT_HOST=127.0.0.1 \
ROBOT_PORT=19001 \
ROBOT_TOKEN=test-token \
npm run dev
```

也可以直接运行已构建的服务。`--lease-seconds` 可用于延长测试租约，默认 60 秒。终端中 `[RX]` 是网关发来的中文动作摘要，`[TX]` 是打印接收端返回的结果摘要，例如“底座前进 0.10 m/s”“控制已启用”。网页端按住方向按钮会持续发送动作保活，松开后发送停止；打印接收端会在保活超时后自动停止模拟动作。
