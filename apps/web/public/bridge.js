(() => {
  const live = new URLSearchParams(location.search).get('live') === '1';
  let socket = null;
  let ready = null;
  let sequence = 0;
  const pending = new Map();
  function nextId() { return `web-${Date.now().toString(36)}-${++sequence}`; }
  function rejectAll(error) { for (const item of pending.values()) item.reject(error); pending.clear(); }
  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/api/control`);
      const timer = setTimeout(() => { reject(new Error('网关连接超时')); socket?.close(); }, 4000);
      socket.addEventListener('message', event => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') { clearTimeout(timer); window.dispatchEvent(new CustomEvent('robot-console-ready', { detail: message })); resolve(message); return; }
        if (message.type === 'ack' && typeof message.id === 'string') {
          const item = pending.get(message.id); if (!item) return;
          pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); return;
        }
        if (message.type === 'robot_status' || message.type === 'robot_message') window.dispatchEvent(new CustomEvent('robot-console-bridge', { detail: message }));
        if (message.ok === false && message.code === 'UNAUTHORIZED') { clearTimeout(timer); reject(new Error('登录状态已失效')); }
      });
      socket.addEventListener('close', () => { socket = null; ready = null; rejectAll(new Error('网关连接已断开')); window.dispatchEvent(new CustomEvent('robot-console-closed')); });
      socket.addEventListener('error', () => {});
    });
    return ready;
  }
  async function request(action, params = {}) {
    if (!live) throw new Error('演示模式未启用网关');
    await connect();
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('网关未连接');
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('网关响应超时')); }, 3500);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ web_v: 1, type: 'intent', id, action, params }));
    });
  }
  function close() { if (socket) socket.close(); }
  window.robotConsoleBridge = Object.freeze({ live, connect, request, close });
  if (live) connect().catch(error => window.dispatchEvent(new CustomEvent('robot-console-bridge-error', { detail: error })));
})();
