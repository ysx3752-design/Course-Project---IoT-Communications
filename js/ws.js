/* 实时通知层
 * 对照 contracts/realtime.md：
 *  - 连接后 5 秒内发送 authenticate，令牌不放 URL
 *  - authenticated 之后才可 subscribe，subscribe 替换原订阅（≤100 个）
 *  - 应用层 ping 每 20 秒，45 秒无 pong 重连
 *  - 退避 1/2/4/8/16/30 秒 + 抖动
 *  - 本版无历史回放，重连后重新鉴权、订阅并回查 HTTP 快照
 */
TG.realtime = (function () {
  const PING_MS = 20000;
  const PONG_TIMEOUT_MS = 45000;

  let sock = null;
  let status = "idle";
  let opts = null;
  let retry = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let authTimer = null;
  let unsubMock = null;
  let stopped = false;
  let subscribedIds = [];

  function setStatus(s, detail) {
    status = s;
    if (opts && opts.onStatus) opts.onStatus(s, detail);
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    if (authTimer) clearTimeout(authTimer);
    reconnectTimer = pingTimer = pongTimer = authTimer = null;
  }

  function send(obj) {
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj));
  }

  function backoffMs() {
    const base = [1000, 2000, 4000, 8000, 16000, 30000][Math.min(retry, 5)];
    return base + Math.floor(Math.random() * 400);
  }

  function scheduleReconnect(reason) {
    if (stopped) return;
    clearTimers();
    retry += 1;
    const wait = backoffMs();
    setStatus("closed", reason + " · " + Math.round(wait / 1000) + " 秒后重连");
    reconnectTimer = setTimeout(connect, wait);
  }

  /* ---------------- 模拟模式 ---------------- */

  function connectMock() {
    setStatus("connecting");
    setTimeout(() => {
      setStatus("authenticating");
      setTimeout(() => {
        setStatus("subscribing");
        setTimeout(() => {
          if (unsubMock) unsubMock();
          unsubMock = TG.mock.onNotification((n) => {
            if (opts.onNotification) opts.onNotification(n);
          });
          retry = 0;
          setStatus("ready", "模拟通道");
          if (opts.onReady) opts.onReady();
        }, 180);
      }, 160);
    }, 160);
  }

  /* ---------------- 真实 WebSocket ---------------- */

  function connect() {
    if (TG.config.useMock) {
      clearTimers();
      connectMock();
      return;
    }

    clearTimers();
    setStatus("connecting");

    try {
      sock = new WebSocket(TG.config.wsUrl());
    } catch (e) {
      scheduleReconnect("无法建立连接");
      return;
    }

    sock.onopen = () => {
      setStatus("authenticating");
      // 契约：建立连接后 5 秒内发送 authenticate
      send({ type: "authenticate", access_token: opts.getToken() });
      authTimer = setTimeout(() => {
        if (status === "authenticating") {
          try {
            sock.close(1008, "auth timeout");
          } catch (e) {}
        }
      }, 5000);
    };

    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }

      if (msg.type === "authenticated") {
        clearTimeout(authTimer);
        setStatus("subscribing");
        // 契约：鉴权通过后才订阅
        const ids = opts.getGatewayIds();
        subscribedIds = ids;
        send({ type: "subscribe", gateway_ids: ids });
        return;
      }

      if (msg.type === "subscribed") {
        retry = 0;
        setStatus("ready");
        startPing();
        // 契约：订阅确认后再回查 HTTP 快照，避免遗漏期间的变更
        if (opts.onReady) opts.onReady();
        return;
      }

      if (msg.type === "pong") {
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = null;
        return;
      }

      if (msg.type === "error") {
        setStatus("error", msg.code);
        return;
      }

      // device.state_changed / gateway.status_changed / command.updated
      if (opts.onNotification) opts.onNotification(msg);
    };

    sock.onclose = (ev) => {
      clearTimers();
      if (ev.code === 1008) {
        // 鉴权失败或令牌过期，不做快速重试
        stopped = true;
        setStatus("error", "鉴权失败（1008）");
        return;
      }
      scheduleReconnect("连接断开 " + (ev.code || ""));
    };

    sock.onerror = () => {
      /* onclose 会跟着触发，这里不重复处理 */
    };
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      send({ type: "ping" });
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        if (sock) {
          try {
            sock.close(4000, "ping timeout");
          } catch (e) {}
        }
      }, PONG_TIMEOUT_MS - PING_MS);
    }, PING_MS);
  }

  return {
    start(options) {
      opts = options;
      stopped = false;
      retry = 0;
      connect();
    },
    status: () => status,
    // 网关列表变化后重新订阅（替换原订阅）
    resubscribe(ids) {
      if (status !== "ready") return;
      subscribedIds = ids;
      if (TG.config.useMock) return;
      send({ type: "subscribe", gateway_ids: ids });
    },
    stop() {
      stopped = true;
      clearTimers();
      if (unsubMock) unsubMock();
      if (sock) {
        try {
          sock.close(1000, "client stop");
        } catch (e) {}
      }
    },
  };
})();
