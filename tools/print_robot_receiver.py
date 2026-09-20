#!/usr/bin/env python3
"""A small ZRCP/1 receiver for Robot Station integration testing.

It deliberately has no robot hardware dependency.  It accepts the same
length-prefixed JSON frames as a real receiver, applies the control/lease
rules used by the gateway, and prints human-readable summaries of messages.
"""

from __future__ import annotations

import argparse
import json
import secrets
import socketserver
import threading
import time
from typing import Any, Optional


PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 65_536
LEASE_SECONDS = 60.0
QUIET_COMMANDS = {"system.ping", "control.heartbeat", "motion.keepalive"}
MOTION_COMMANDS = {
    "base.jog",
    "body.lift.jog",
    "body.pitch.jog",
    "waist.yaw.jog",
    "arm.position.jog",
    "arm.rotation.jog",
    "arm.move_to",
    "gripper.jog",
    "head.jog",
    "head.center",
}


def robot_time_ms() -> int:
    return time.monotonic_ns() // 1_000_000


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def number(value: Any, digits: int = 2) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "?"


def numeric(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def direction(value: Any, positive: str, negative: str, unit: str, digits: int = 2) -> str:
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return "未知方向"
    if abs(amount) < 1e-9:
        return "停止"
    return f"{positive if amount > 0 else negative} {number(abs(amount), digits)} {unit}"


def command_summary(command: str, params: dict[str, Any]) -> str:
    arm = "左手" if params.get("arm") == "left" else "右手" if params.get("arm") == "right" else "机械臂"
    if command == "system.hello":
        return f"握手请求（客户端：{params.get('client_name', '未知')}）"
    if command == "system.describe":
        return "读取机器人能力"
    if command in {"system.ping", "control.heartbeat", "motion.keepalive"}:
        return "链路保活"
    if command == "state.get":
        return "读取机器人状态"
    if command == "state.subscribe":
        return f"订阅机器人状态（{params.get('rate_hz', '?')} Hz）"
    if command == "control.acquire":
        return "申请控制权"
    if command == "control.enable":
        return "启用控制"
    if command == "control.release":
        return "释放控制权"
    if command == "motion.stop_all":
        return "停止全部动作"
    if command == "motion.stop":
        return f"停止当前动作（{params.get('motion_id', '未知动作')}）"
    if command == "base.jog":
        parts = []
        linear = numeric(params.get("linear_mps"))
        angular = numeric(params.get("angular_radps"))
        if abs(linear) >= 1e-9:
            parts.append(direction(linear, "底座前进", "底座后退", "m/s"))
        if abs(angular) >= 1e-9:
            parts.append(direction(angular, "底座左转", "底座右转", "rad/s"))
        return "、".join(parts) if parts else "底座停止"
    if command == "body.lift.jog":
        return direction(params.get("velocity_mps", 0), "身体上升", "身体下降", "m/s")
    if command == "body.pitch.jog":
        return direction(params.get("velocity_radps", 0), "身体前倾", "身体后仰", "rad/s")
    if command == "waist.yaw.jog":
        return direction(params.get("velocity_radps", 0), "腰部左转", "腰部右转", "rad/s")
    if command == "arm.position.jog":
        axis = {"x": ("向前", "向后"), "y": ("向左", "向右"), "z": ("抬升", "下降")}.get(params.get("axis"), ("正向", "反向"))
        return f"{arm}{direction(params.get('velocity_mps', 0), axis[0], axis[1], 'm/s')}"
    if command == "arm.rotation.jog":
        axis = {"x": ("向右倾", "向左倾"), "y": ("向下俯", "向上仰"), "z": ("向左转", "向右转")}.get(params.get("axis"), ("正向转动", "反向转动"))
        return f"{arm}{direction(params.get('velocity_radps', 0), axis[0], axis[1], 'rad/s')}"
    if command == "arm.move_to":
        position = params.get("position_m")
        if isinstance(position, list) and len(position) == 3:
            return f"{arm}移动到目标（X {number(numeric(position[0]) * 1000, 1)} mm，Y {number(numeric(position[1]) * 1000, 1)} mm，Z {number(numeric(position[2]) * 1000, 1)} mm）"
        return f"{arm}移动到目标位置"
    if command == "gripper.jog":
        return f"{arm}{direction(params.get('velocity_ratio_per_s', 0), '夹爪张开', '夹爪闭合', '%/s')}"
    if command == "head.jog":
        axis = params.get("axis")
        if axis == "yaw":
            return direction(params.get("velocity_radps", 0), "头部左看", "头部右看", "rad/s")
        return direction(params.get("velocity_radps", 0), "头部抬头", "头部低头", "rad/s")
    if command == "head.center":
        return "头部回正"
    return f"收到未分类命令：{command}"


def response_summary(request: dict[str, Any], result: dict[str, Any]) -> str:
    command = str(request.get("command", "未知命令"))
    if result.get("ok"):
        success = {
            "system.hello": "握手成功",
            "system.describe": "能力读取成功",
            "state.get": "状态读取成功",
            "control.acquire": "控制权已获取",
            "control.enable": "控制已启用",
            "control.release": "控制权已释放",
            "motion.stop": "当前动作已停止",
            "motion.stop_all": "全部动作已停止",
            "arm.move_to": "目标动作已接受",
            "head.center": "头部回正动作已接受",
        }
        return success.get(command, "操作成功")
    errors = {
        "UNAUTHORIZED": "令牌错误",
        "CONTROL_BUSY": "控制权已被占用",
        "LEASE_REQUIRED": "缺少有效控制权",
        "LEASE_INVALID": "控制权无效",
        "CONTROL_DISABLED": "控制尚未启用",
        "INVALID_ARGUMENT": "参数无效",
        "UNKNOWN_COMMAND": "命令不支持",
    }
    code = str(result.get("code", "ERROR"))
    return f"操作失败：{errors.get(code, code)}"


class ReceiverState:
    """Shared receiver state, including the single global control lease."""

    def __init__(self, token: str, lease_seconds: float = LEASE_SECONDS) -> None:
        self.token = token
        self.lease_seconds = lease_seconds
        self.lock = threading.RLock()
        self.session_id: Optional[str] = None
        self.lease_id: Optional[str] = None
        self.lease_deadline = 0.0
        self.enabled = False
        self.motion: Optional[dict[str, Any]] = None

    def expire_locked(self) -> None:
        if self.lease_id and time.monotonic() >= self.lease_deadline:
            self._clear_lease_locked()

    def _clear_lease_locked(self) -> None:
        self.session_id = None
        self.lease_id = None
        self.lease_deadline = 0.0
        self.enabled = False
        self.motion = None

    def disconnect(self, session_id: Optional[str]) -> None:
        with self.lock:
            if session_id and session_id == self.session_id:
                self._clear_lease_locked()

    def check_lease_locked(self, session_id: str, params: dict[str, Any]) -> Optional[dict[str, Any]]:
        self.expire_locked()
        if not self.lease_id or self.session_id != session_id:
            return self.error("LEASE_REQUIRED", "A valid control lease is required.")
        if params.get("lease_id") != self.lease_id:
            return self.error("LEASE_INVALID", "The control lease is invalid.")
        self.lease_deadline = time.monotonic() + self.lease_seconds
        return None

    @staticmethod
    def error(code: str, msg: str, data: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        return {"ok": False, "code": code, "msg": msg, "data": data or {}}

    @staticmethod
    def ok(msg: str = "OK", data: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        return {"ok": True, "code": "OK", "msg": msg, "data": data or {}}

    def command(self, session_id: str, name: str, params: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.expire_locked()

            if name == "system.ping":
                return self.ok("Pong", {"robot_id": "print-receiver"})
            if name == "system.describe":
                return self.ok(
                    "Print receiver capabilities",
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "robot_id": "print-receiver",
                        "robot_name": "ZRCP Print Receiver",
                        "role": "operator",
                        "max_frame_bytes": MAX_FRAME_BYTES,
                        "commands": sorted(MOTION_COMMANDS | {
                            "system.hello", "system.ping", "system.describe", "state.get",
                            "state.subscribe", "control.acquire", "control.enable",
                            "control.heartbeat", "control.release", "motion.stop",
                            "motion.stop_all", "motion.keepalive",
                        }),
                    },
                )
            if name in {"state.get", "state.subscribe"}:
                return self.ok("State snapshot", self.state_data_locked())
            if name == "control.acquire":
                if self.lease_id and self.session_id != session_id:
                    return self.error("CONTROL_BUSY", "Another session holds the control lease.")
                if not self.lease_id:
                    self.session_id = session_id
                    self.lease_id = f"print-lease-{secrets.token_hex(6)}"
                    self.lease_deadline = time.monotonic() + self.lease_seconds
                else:
                    self.lease_deadline = time.monotonic() + self.lease_seconds
                return self.ok("Control lease acquired", {
                    "lease_id": self.lease_id,
                    "lease_expires_ms": robot_time_ms() + int(self.lease_seconds * 1000),
                })
            if name == "control.enable":
                failure = self.check_lease_locked(session_id, params)
                if failure:
                    return failure
                self.enabled = True
                return self.ok("Control enabled", {"enabled": True})
            if name == "control.heartbeat":
                failure = self.check_lease_locked(session_id, params)
                if failure:
                    return failure
                return self.ok("Control lease renewed", {
                    "lease_expires_ms": robot_time_ms() + int(self.lease_seconds * 1000),
                })
            if name == "control.release":
                if not self.lease_id:
                    return self.ok("Control already released")
                failure = self.check_lease_locked(session_id, params)
                if failure:
                    return failure
                self._clear_lease_locked()
                return self.ok("Control released", {"enabled": False})
            if name == "motion.stop_all":
                if self.lease_id:
                    failure = self.check_lease_locked(session_id, params)
                    if failure:
                        return failure
                self.motion = None
                self.enabled = False
                return self.ok("All motion stopped", {"stop_requested": True, "enabled": False})

            if name in MOTION_COMMANDS | {"motion.stop", "motion.keepalive"}:
                failure = self.check_lease_locked(session_id, params)
                if failure:
                    return failure
                if not self.enabled:
                    return self.error("CONTROL_DISABLED", "Control must be enabled first.")
                motion_id = params.get("motion_id")
                if not isinstance(motion_id, str) or not motion_id:
                    return self.error("INVALID_ARGUMENT", "motion_id is required.")

                if name == "motion.keepalive":
                    if not self.motion or self.motion["motion_id"] != motion_id:
                        return self.error("MOTION_NOT_FOUND", "No active motion matches motion_id.")
                    seq = params.get("seq")
                    if not isinstance(seq, int) or isinstance(seq, bool):
                        return self.error("INVALID_ARGUMENT", "seq must be an integer.")
                    if seq <= self.motion["seq"]:
                        return self.error("SEQUENCE_REPLAY", "Motion sequence must increase.")
                    self.motion["seq"] = seq
                    return self.ok("Motion keepalive accepted", {"motion_id": motion_id, "phase": "running"})

                if name == "motion.stop":
                    if self.motion and self.motion["motion_id"] == motion_id:
                        self.motion = None
                    return self.ok("Motion stopped", {"motion_id": motion_id, "stop_requested": True})

                if self.motion and self.motion["motion_id"] != motion_id:
                    return self.error("MOTION_BUSY", "Another motion is already active.")
                seq = params.get("seq", 1)
                if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
                    return self.error("INVALID_ARGUMENT", "seq must be a positive integer.")
                self.motion = {"motion_id": motion_id, "seq": seq, "command": name}
                return self.ok("Motion accepted", {"motion_id": motion_id, "phase": "accepted"})

            return self.error("UNKNOWN_COMMAND", f"Unsupported command: {name}")

    def state_data_locked(self) -> dict[str, Any]:
        return {
            "robot_id": "print-receiver",
            "enabled": self.enabled,
            "control_held": self.lease_id is not None,
            "active_motion": dict(self.motion) if self.motion else None,
        }


class PrintReceiverHandler(socketserver.BaseRequestHandler):
    state: ReceiverState

    def setup(self) -> None:
        self.state = self.server.state  # type: ignore[attr-defined]
        self.session_id: Optional[str] = None
        self.send_lock = threading.Lock()
        self.buffer = bytearray()
        self.request.settimeout(1.0)
        print(f"[CONN] {self.client_address[0]}:{self.client_address[1]}", flush=True)

    def finish(self) -> None:
        self.state.disconnect(self.session_id)
        print(f"[CLOSE] {self.client_address[0]}:{self.client_address[1]}", flush=True)

    def send_response(self, request: dict[str, Any], result: dict[str, Any], session_id: Optional[str]) -> None:
        response = {
            "v": PROTOCOL_VERSION,
            "type": "response",
            "id": request.get("id", "receiver-error"),
            "session_id": session_id,
            "command": request.get("command", "unknown"),
            "robot_time_ms": robot_time_ms(),
            **result,
        }
        payload = json_line(response).encode("utf-8")
        if len(payload) > MAX_FRAME_BYTES:
            raise ValueError("response exceeds maximum frame size")
        frame = len(payload).to_bytes(4, "big") + payload
        with self.send_lock:
            self.request.sendall(frame)
        if request.get("command") not in QUIET_COMMANDS:
            print(f"[TX] {response_summary(request, result)}", flush=True)

    def send_error_and_close(self, request: dict[str, Any], code: str, msg: str) -> None:
        try:
            self.send_response(request, ReceiverState.error(code, msg), self.session_id)
        except Exception:
            pass
        self.request.close()

    def handle_frame(self, payload: bytes) -> bool:
        try:
            message = json.loads(payload.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            print(f"[ERROR] invalid JSON frame: {exc}", flush=True)
            return False
        if not isinstance(message, dict) or message.get("v") != PROTOCOL_VERSION or message.get("type") != "command":
            print("[ERROR] invalid ZRCP command envelope", flush=True)
            return False
        command = message.get("command")
        request_id = message.get("id")
        params = message.get("params")
        if not isinstance(command, str) or not isinstance(request_id, str) or not isinstance(params, dict):
            self.send_error_and_close(message, "INVALID_MESSAGE", "Invalid command fields")
            return False
        if command not in QUIET_COMMANDS:
            print(f"[RX] {command_summary(command, params)}", flush=True)

        if command == "system.hello":
            versions = params.get("supported_versions")
            token = params.get("token")
            if not isinstance(versions, list) or PROTOCOL_VERSION not in versions:
                self.send_response(message, ReceiverState.error("VERSION_UNSUPPORTED", "ZRCP/1 is not supported"), None)
                return False
            if token != self.state.token:
                self.send_response(message, ReceiverState.error("UNAUTHORIZED", "Invalid receiver token"), None)
                return False
            self.session_id = f"print-session-{secrets.token_hex(6)}"
            self.send_response(message, ReceiverState.ok("Hello", {
                "protocol_version": PROTOCOL_VERSION,
                "robot_id": "print-receiver",
                "robot_name": "ZRCP Print Receiver",
                "role": "operator",
                "max_frame_bytes": MAX_FRAME_BYTES,
            }), self.session_id)
            return True

        if not self.session_id:
            self.send_response(message, ReceiverState.error("SESSION_INVALID", "system.hello is required first"), None)
            return False
        if message.get("session_id") != self.session_id:
            self.send_response(message, ReceiverState.error("SESSION_INVALID", "Session id is invalid"), self.session_id)
            return False
        result = self.state.command(self.session_id, command, params)
        self.send_response(message, result, self.session_id)
        return True

    def handle(self) -> None:
        while True:
            try:
                chunk = self.request.recv(4096)
            except TimeoutError:
                continue
            except OSError:
                break
            if not chunk:
                break
            self.buffer.extend(chunk)
            while True:
                if len(self.buffer) < 4:
                    break
                length = int.from_bytes(self.buffer[:4], "big")
                if length < 1 or length > MAX_FRAME_BYTES:
                    print(f"[ERROR] invalid frame length: {length}", flush=True)
                    return
                if len(self.buffer) < length + 4:
                    break
                payload = bytes(self.buffer[4:length + 4])
                del self.buffer[:length + 4]
                if not self.handle_frame(payload):
                    return


class PrintReceiverServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], state: ReceiverState):
        self.state = state
        super().__init__(server_address, PrintReceiverHandler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Print-only ZRCP/1 receiver for Robot Station")
    parser.add_argument("--host", default="0.0.0.0", help="listen address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=9000, help="listen port (default: 9000)")
    parser.add_argument("--token", default="print-receiver-token", help="token expected by system.hello")
    parser.add_argument("--lease-seconds", type=float, default=LEASE_SECONDS, help="lease duration (default: 60)")
    args = parser.parse_args()
    state = ReceiverState(args.token, max(1.0, args.lease_seconds))
    with PrintReceiverServer((args.host, args.port), state) as server:
        print(f"[READY] ZRCP/1 print receiver listening on {args.host}:{args.port}", flush=True)
        print(f"[READY] token={args.token!r} lease_seconds={state.lease_seconds:g}", flush=True)
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            print("[STOP] receiver stopped", flush=True)


if __name__ == "__main__":
    main()
