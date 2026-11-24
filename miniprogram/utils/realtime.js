/**
 * 实时通知（WSS）
 * 契约：contracts/realtime.md
 *  - 连接后 5 秒内发 authenticate，令牌不放 URL
 *  - authenticated 之后才 subscribe，每次 subscribe 替换原订阅
 *  - 应用层 ping 每 20 秒，45 秒无 pong 重连
 *  - 退避 1/2/4/8/16/30 秒 + 抖动
 */
var config = require("./config");

var PING_MS = 20000;
var PONG_TIMEOUT_MS = 45000;

var task = null;
var status = "idle";
var retry = 0;
var stopped = false;
var opts = null;
var timers = {};
var lastPongAt = 0;

function setStatus(s, detail) {
  status = s;
  if (opts && opts.onStatus) opts.onStatus(s, detail || "");
}

function clearTimers() {
  ["auth", "reconnect", "ping"].forEach(function (k) {
    if (timers[k]) {
      clearTimeout(timers[k]);
      clearInterval(timers[k]);
      timers[k] = null;
    }
  });
}

function backoffMs() {
  var table = [1000, 2000, 4000, 8000, 16000, 30000];
  return table[Math.min(retry, table.length - 1)] + Math.floor(Math.random() * 400);
}

function send(obj) {
  if (!task) return;
  task.send({ data: JSON.stringify(obj) });
}

function scheduleReconnect(reason) {
  if (stopped) return;
  clearTimers();
  retry += 1;
  var wait = backoffMs();
  setStatus("closed", (reason || "连接断开") + "，" + Math.round(wait / 1000) + " 秒后重连");
  timers.reconnect = setTimeout(connect, wait);
}

function startPing() {
  lastPongAt = Date.now();
  timers.ping = setInterval(function () {
    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
      try {
        task.close({ code: 4000, reason: "ping timeout" });
      } catch (e) {}
      return;
    }
    send({ type: "ping" });
  }, PING_MS);
}

function connect() {
  clearTimers();
  setStatus("connecting");

  task = wx.connectSocket({
    url: config.wsUrl(),
    fail: function () {
      scheduleReconnect("无法建立连接");
    }
  });

  if (!task) return;

  task.onOpen(function () {
    setStatus("authenticating");
    // 契约：建连后 5 秒内鉴权
    send({ type: "authenticate", access_token: config.getToken() });
    timers.auth = setTimeout(function () {
      if (status === "authenticating") {
        try { task.close({ code: 1008, reason: "auth timeout" }); } catch (e) {}
      }
    }, 5000);
  });

  task.onMessage(function (res) {
    var msg;
    try { msg = JSON.parse(res.data); } catch (e) { return; }

    if (msg.type === "authenticated") {
      clearTimeout(timers.auth);
      setStatus("subscribing");
      send({ type: "subscribe", gateway_ids: opts.getGatewayIds() });
      return;
    }
    if (msg.type === "subscribed") {
      retry = 0;
      setStatus("ready");
      startPing();
      if (opts.onReady) opts.onReady();
      return;
    }
    if (msg.type === "pong") {
      lastPongAt = Date.now();
      return;
    }
    if (msg.type === "error") {
      setStatus("error", msg.code || "");
      return;
    }
    if (opts.onNotification) opts.onNotification(msg);
  });

  task.onClose(function () {
    clearTimers();
    if (stopped) return;
    scheduleReconnect("连接断开");
  });

  task.onError(function () {
    // onClose 会紧随其后，这里不重复处理
  });
}

function start(options) {
  opts = options;
  stopped = false;
  retry = 0;
  connect();
}

function stop() {
  stopped = true;
  clearTimers();
  if (task) {
    try { task.close({ code: 1000, reason: "manual" }); } catch (e) {}
    task = null;
  }
}

function resubscribe(ids) {
  if (status !== "ready") return;
  send({ type: "subscribe", gateway_ids: ids });
}

module.exports = {
  start: start,
  stop: stop,
  resubscribe: resubscribe,
  getStatus: function () { return status; }
};
