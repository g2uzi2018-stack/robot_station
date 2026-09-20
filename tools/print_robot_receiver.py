#!/usr/bin/env python3
"""A small ZRCP/1 receiver for Robot Station integration testing.

It deliberately has no robot hardware dependency.  It accepts the same
length-prefixed JSON frames as a real receiver, applies the control/lease
rules used by the gateway, and prints human-readable summaries of messages.
"""

from __future__ import annotations

import argparse
import json
import math
import secrets
import socketserver
import threading
import time
from typing import Any, Optional


PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 65_536
LEASE_SECONDS = 60.0
MOTION_WATCHDOG_SECONDS = 0.75
STATE_INTERVAL_SECONDS = 0.1
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


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def move_towards(current: float, target: float, step: float) -> float:
    if abs(target - current) <= step:
        return target
    return current + math.copysign(step, target - current)


def quaternion_from_euler(roll: float, pitch: float, yaw: float) -> list[float]:
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    return [
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    ]


def quaternion_distance(left: list[float], right: list[float]) -> float:
    dot = abs(sum(a * b for a, b in zip(left, right)))
    return 2 * math.acos(clamp(dot, -1.0, 1.0))


class ReceiverState:
    """Shared lease and a small deterministic robot model for protocol testing."""

    def __init__(self, token: str, lease_seconds: float = LEASE_SECONDS) -> None:
        self.token = token
        self.lease_seconds = lease_seconds
        self.lock = threading.RLock()
        self.session_id: Optional[str] = None
        self.lease_id: Optional[str] = None
        self.lease_deadline = 0.0
        self.enabled = False
        self.motion: Optional[dict[str, Any]] = None
        self.last_update = time.monotonic()
        self.pending_events: list[dict[str, Any]] = []
        self.base_linear = 0.0
        self.base_angular = 0.0
        self.body_lift = 0.48
        self.body_pitch = 0.0
        self.waist_yaw = 0.0
        self.head_yaw = 0.0
        self.head_pitch = 0.0
        self.arm_positions = {"left": [0.35, 0.24, 0.68], "right": [0.35, -0.24, 0.68]}
        self.arm_euler = {"left": [0.0, 0.0, 0.0], "right": [0.0, 0.0, 0.0]}
        self.grippers = {"left": 0.65, "right": 0.65}

    def expire_locked(self) -> None:
        if self.lease_id and time.monotonic() >= self.lease_deadline:
            self._advance_motion_locked()
            if self.motion:
                self._finish_motion_locked("failed", "LEASE_EXPIRED", "控制租约已过期，动作已停止")
            self._clear_lease_locked()

    def _clear_lease_locked(self) -> None:
        self.session_id = None
        self.lease_id = None
        self.lease_deadline = 0.0
        self.enabled = False
        self.motion = None
        self.base_linear = 0.0
        self.base_angular = 0.0

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

    def _advance_motion_locked(self, now: Optional[float] = None) -> None:
        now = time.monotonic() if now is None else now
        dt = clamp(now - self.last_update, 0.0, 0.25)
        self.last_update = now
        motion = self.motion
        if not motion:
            self.base_linear = 0.0
            self.base_angular = 0.0
            return
        if now - float(motion["last_keepalive"]) > MOTION_WATCHDOG_SECONDS:
            self._finish_motion_locked("stopped", "WATCHDOG_STOPPED", "动作保活超时，已停止")
            return

        command = motion["command"]
        params = motion["params"]
        if command == "base.jog":
            self.base_linear = numeric(params.get("linear_mps"))
            self.base_angular = numeric(params.get("angular_radps"))
            return
        self.base_linear = 0.0
        self.base_angular = 0.0
        if command == "body.lift.jog":
            self.body_lift = clamp(self.body_lift + numeric(params.get("velocity_mps")) * dt, 0.30, 1.05)
        elif command == "body.pitch.jog":
            self.body_pitch = clamp(self.body_pitch + numeric(params.get("velocity_radps")) * dt, -math.radians(30), math.radians(30))
        elif command == "waist.yaw.jog":
            self.waist_yaw += numeric(params.get("velocity_radps")) * dt
        elif command == "arm.position.jog":
            arm = params.get("arm") if params.get("arm") in self.arm_positions else "left"
            axis = {"x": 0, "y": 1, "z": 2}.get(params.get("axis"))
            if axis is not None:
                limits = ((0.10, 0.65), (-0.60, 0.60), (0.30, 1.05))[axis]
                position = self.arm_positions[arm]
                position[axis] = clamp(position[axis] + numeric(params.get("velocity_mps")) * dt, *limits)
        elif command == "arm.rotation.jog":
            arm = params.get("arm") if params.get("arm") in self.arm_euler else "left"
            axis = {"x": 0, "y": 1, "z": 2}.get(params.get("axis"))
            if axis is not None:
                self.arm_euler[arm][axis] += numeric(params.get("velocity_radps")) * dt
        elif command == "gripper.jog":
            arm = params.get("arm") if params.get("arm") in self.grippers else "left"
            self.grippers[arm] = clamp(self.grippers[arm] + numeric(params.get("velocity_ratio_per_s")) * dt, 0.0, 1.0)
        elif command == "head.jog":
            if params.get("axis") == "yaw":
                self.head_yaw = clamp(self.head_yaw + numeric(params.get("velocity_radps")) * dt, -math.pi, math.pi)
            else:
                self.head_pitch = clamp(self.head_pitch + numeric(params.get("velocity_radps")) * dt, -math.radians(45), math.radians(45))
        elif command == "arm.move_to":
            self._advance_arm_target_locked(params, dt)
        elif command == "head.center":
            speed = max(abs(numeric(params.get("max_angular_radps"), math.radians(30))), 0.01)
            self.head_yaw = move_towards(self.head_yaw, 0.0, speed * dt)
            self.head_pitch = move_towards(self.head_pitch, 0.0, speed * dt)
            if abs(self.head_yaw) < 0.002 and abs(self.head_pitch) < 0.002:
                self.head_yaw = self.head_pitch = 0.0
                self._finish_motion_locked("completed", "OK", "头部回正完成")

    def _advance_arm_target_locked(self, params: dict[str, Any], dt: float) -> None:
        arm = params.get("arm") if params.get("arm") in self.arm_positions else "left"
        target = params.get("position_m")
        if not isinstance(target, list) or len(target) != 3:
            self._finish_motion_locked("failed", "INVALID_ARGUMENT", "目标位置无效")
            return
        target_position = [numeric(value) for value in target]
        speed = max(abs(numeric(params.get("max_linear_mps"), 0.12)), 0.01)
        current = self.arm_positions[arm]
        distance = math.sqrt(sum((target_position[i] - current[i]) ** 2 for i in range(3)))
        if distance > 0:
            step = min(distance, speed * dt)
            ratio = step / distance
            for index in range(3):
                current[index] += (target_position[index] - current[index]) * ratio
        target_orientation = params.get("orientation_xyzw")
        if isinstance(target_orientation, list) and len(target_orientation) == 4:
            current_q = quaternion_from_euler(*self.arm_euler[arm])
            target_q = [numeric(value) for value in target_orientation]
            norm = math.sqrt(sum(value * value for value in target_q)) or 1.0
            target_q = [value / norm for value in target_q]
            angular_speed = max(abs(numeric(params.get("max_angular_radps"), math.radians(45))), 0.01)
            alpha = clamp(angular_speed * dt / max(quaternion_distance(current_q, target_q), 0.001), 0.0, 1.0)
            interpolated = [current_q[i] + (target_q[i] - current_q[i]) * alpha for i in range(4)]
            norm = math.sqrt(sum(value * value for value in interpolated)) or 1.0
            interpolated = [value / norm for value in interpolated]
            # The simulator only needs a stable feedback quaternion. Keep the
            # orientation target exact once the position has arrived.
            if distance <= 0.002 and quaternion_distance(interpolated, target_q) <= 0.01:
                interpolated = target_q
            self.arm_euler[arm] = self._euler_from_quaternion(interpolated)
            orientation_done = quaternion_distance(interpolated, target_q) <= 0.01
        else:
            orientation_done = True
        if distance <= 0.002 and orientation_done:
            self.arm_positions[arm] = target_position
            self._finish_motion_locked("completed", "OK", "目标动作完成")

    @staticmethod
    def _euler_from_quaternion(quaternion: list[float]) -> list[float]:
        x, y, z, w = quaternion
        return [
            math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
            math.asin(clamp(2 * (w * y - z * x), -1.0, 1.0)),
            math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
        ]

    def _finish_motion_locked(self, phase: str, code: str, msg: str) -> None:
        motion = self.motion
        if not motion:
            return
        self.motion = None
        self.base_linear = 0.0
        self.base_angular = 0.0
        self.pending_events.append({
            "motion_id": motion["motion_id"],
            "phase": phase,
            "code": code,
            "msg": msg,
            "data": self.state_data_locked(),
        })

    def command(self, session_id: str, name: str, params: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.expire_locked()
            self._advance_motion_locked()

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
                        "state_rate_hz": 10,
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
                if self.motion:
                    self._finish_motion_locked("stopped", "STOPPED", "控制权释放，动作已停止")
                self._clear_lease_locked()
                return self.ok("Control released", {"enabled": False})
            if name == "motion.stop_all":
                if self.lease_id:
                    failure = self.check_lease_locked(session_id, params)
                    if failure:
                        return failure
                if self.motion:
                    self._finish_motion_locked("stopped", "STOPPED", "全部动作已停止")
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
                    self.motion["last_keepalive"] = time.monotonic()
                    return self.ok("Motion keepalive accepted", {"motion_id": motion_id, "phase": "running"})

                if name == "motion.stop":
                    if self.motion and self.motion["motion_id"] == motion_id:
                        self._finish_motion_locked("stopped", "STOPPED", "动作已停止")
                    return self.ok("Motion stopped", {"motion_id": motion_id, "stop_requested": True})

                if self.motion and self.motion["motion_id"] != motion_id:
                    return self.error("MOTION_BUSY", "Another motion is already active.")
                seq = params.get("seq", 1)
                if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
                    return self.error("INVALID_ARGUMENT", "seq must be a positive integer.")
                self.motion = {
                    "motion_id": motion_id,
                    "seq": seq,
                    "command": name,
                    "params": dict(params),
                    "last_keepalive": time.monotonic(),
                }
                return self.ok("Motion accepted", {"motion_id": motion_id, "phase": "accepted"})

            return self.error("UNKNOWN_COMMAND", f"Unsupported command: {name}")

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            self.expire_locked()
            self._advance_motion_locked()
            return self.state_data_locked()

    def drain_events(self) -> list[dict[str, Any]]:
        with self.lock:
            events = self.pending_events
            self.pending_events = []
            return events

    def state_data_locked(self) -> dict[str, Any]:
        return {
            "robot_id": "print-receiver",
            "enabled": self.enabled,
            "control_held": self.lease_id is not None,
            "active_motion": ({
                "motion_id": self.motion["motion_id"],
                "seq": self.motion["seq"],
                "command": self.motion["command"],
                "phase": "running",
            } if self.motion else None),
            "base": {"linear_mps": self.base_linear, "angular_radps": self.base_angular},
            "body": {
                "lift": {"position_m": self.body_lift, "min_m": 0.30, "max_m": 1.05},
                "pitch": {"position_rad": self.body_pitch, "min_rad": -math.radians(30), "max_rad": math.radians(30)},
            },
            "waist": {"yaw": {"position_rad": self.waist_yaw}},
            "arms": {
                arm: {"position_m": list(self.arm_positions[arm]), "orientation_xyzw": quaternion_from_euler(*self.arm_euler[arm])}
                for arm in ("left", "right")
            },
            "grippers": {arm: {"opening_ratio": self.grippers[arm]} for arm in ("left", "right")},
            "head": {
                "yaw": {"position_rad": self.head_yaw},
                "pitch": {"position_rad": self.head_pitch},
            },
        }


class PrintReceiverHandler(socketserver.BaseRequestHandler):
    state: ReceiverState

    def setup(self) -> None:
        self.state = self.server.state  # type: ignore[attr-defined]
        self.session_id: Optional[str] = None
        self.send_lock = threading.Lock()
        self.buffer = bytearray()
        self.request.settimeout(1.0)
        self.feedback_stop = threading.Event()
        self.feedback_interval = STATE_INTERVAL_SECONDS
        self.feedback_thread = threading.Thread(target=self.feedback_loop, name="receiver-feedback", daemon=True)
        self.feedback_thread.start()
        print(f"[CONN] {self.client_address[0]}:{self.client_address[1]}", flush=True)

    def finish(self) -> None:
        self.feedback_stop.set()
        self.state.disconnect(self.session_id)
        print(f"[CLOSE] {self.client_address[0]}:{self.client_address[1]}", flush=True)

    def send_frame(self, message: dict[str, Any]) -> None:
        payload = json_line(message).encode("utf-8")
        if len(payload) > MAX_FRAME_BYTES:
            raise ValueError("message exceeds maximum frame size")
        frame = len(payload).to_bytes(4, "big") + payload
        with self.send_lock:
            self.request.sendall(frame)

    def send_state(self) -> None:
        if not self.session_id:
            return
        self.send_frame({
            "v": PROTOCOL_VERSION,
            "type": "state",
            "session_id": self.session_id,
            "robot_time_ms": robot_time_ms(),
            "data": self.state.snapshot(),
        })

    def send_result(self, event: dict[str, Any]) -> None:
        if not self.session_id:
            return
        message = {
            "v": PROTOCOL_VERSION,
            "type": "result",
            "session_id": self.session_id,
            "robot_time_ms": robot_time_ms(),
            **event,
        }
        self.send_frame(message)
        print(f"[TX] {event.get('msg', event.get('phase', '动作已结束'))}", flush=True)

    def flush_feedback(self) -> None:
        if not self.session_id:
            return
        for event in self.state.drain_events():
            self.send_result(event)
        self.send_state()

    def feedback_loop(self) -> None:
        while not self.feedback_stop.wait(self.feedback_interval):
            if not self.session_id:
                continue
            try:
                self.flush_feedback()
            except (OSError, ValueError):
                return

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
        self.send_frame(response)
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
            self.flush_feedback()
            return True

        if not self.session_id:
            self.send_response(message, ReceiverState.error("SESSION_INVALID", "system.hello is required first"), None)
            return False
        if message.get("session_id") != self.session_id:
            self.send_response(message, ReceiverState.error("SESSION_INVALID", "Session id is invalid"), self.session_id)
            return False
        result = self.state.command(self.session_id, command, params)
        self.send_response(message, result, self.session_id)
        if command == "state.subscribe":
            rate_hz = clamp(numeric(params.get("rate_hz"), 10.0), 1.0, 20.0)
            self.feedback_interval = 1.0 / rate_hz
        self.flush_feedback()
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
