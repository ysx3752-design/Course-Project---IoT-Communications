/**
 * 全局状态：快照合并 + 命令生命周期
 * 合并规则来自契约 device-models.md / realtime.md：
 *  - state_revision / command_revision 单调，只应用更高值
 *  - 命令终态不可变，禁止状态倒退
 *  - 202 只代表受理，终态要靠推送或轮询
 */
var api = require("./api");
var fmt = require("./format");

var TERMINAL = ["succeeded", "failed", "expired"];
var RANK = { queued: 1, dispatched: 2, accepted: 3, succeeded: 4, failed: 5, expired: 5 };

var state = {
  gateways: [],
  devices: [],
  commands: {},      // command_id -> Command
  events: [],
  selectedId: "",
  pending: {},       // "dev:ep:prop" -> 期望值（乐观显示）
  wsStatus: "idle",
  wsDetail: "",
  loading: false,
  lastError: ""
};

var listeners = [];
var pollTimers = {};

function emit() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](state); } catch (e) { console.error(e); }
  }
}

function subscribe(fn) {
  listeners.push(fn);
  return function () {
    listeners = listeners.filter(function (f) { return f !== fn; });
  };
}

function getState() { return state; }

function isTerminal(s) { return TERMINAL.indexOf(s) >= 0; }

/* ---------------- 合并 ---------------- */

function applyGateway(snap) {
  var i = -1;
  for (var k = 0; k < state.gateways.length; k++) {
    if (state.gateways[k].gateway_id === snap.gateway_id) { i = k; break; }
  }
  if (i >= 0 && state.gateways[i].state_revision >= snap.state_revision) return false;
  if (i >= 0) state.gateways[i] = snap;
  else state.gateways.push(snap);
  return true;
}

function applyDevice(snap) {
  var i = -1;
  for (var k = 0; k < state.devices.length; k++) {
    if (state.devices[k].device_id === snap.device_id) { i = k; break; }
  }
  if (i >= 0 && state.devices[i].state_revision >= snap.state_revision) return false;
  if (i >= 0) state.devices[i] = snap;
  else state.devices.push(snap);
  return true;
}

function applyCommand(cmd) {
  var cur = state.commands[cmd.command_id];
  if (cur) {
    if (isTerminal(cur.status)) return false;                       // 终态不可变
    if (cmd.command_revision <= cur.command_revision) return false; // 修订号单调
    if (RANK[cmd.status] < RANK[cur.status]) return false;          // 禁止倒退
  }
  state.commands[cmd.command_id] = cmd;
  return true;
}

/* ---------------- 加载 ---------------- */

function loadSnapshot() {
  state.loading = true;
  emit();
  return Promise.all([
    api.listGateways({ limit: 100 }),
    api.listDevices({ limit: 100 })
  ]).then(function (res) {
    state.gateways = (res[0].data && res[0].data.items) || [];
    state.devices = (res[1].data && res[1].data.items) || [];
    state.loading = false;
    state.lastError = "";
    emit();
    return state;
  }, function (err) {
    state.loading = false;
    state.lastError = err.code || "加载失败";
    emit();
    throw err;
  });
}

function loadEvents(deviceId) {
  return api.listEvents(deviceId, { limit: 20 }).then(function (res) {
    if (state.selectedId !== deviceId) return;
    state.events = (res.data && res.data.items) || [];
    emit();
  }, function () {
    // 事件加载失败不打断主流程
  });
}

function selectDevice(deviceId) {
  state.selectedId = deviceId;
  state.events = [];
  emit();
  return loadEvents(deviceId);
}

function findDevice(deviceId) {
  for (var i = 0; i < state.devices.length; i++) {
    if (state.devices[i].device_id === deviceId) return state.devices[i];
  }
  return null;
}

/* ---------------- 命令下发 ---------------- */

function watchCommand(id) {
  if (pollTimers[id]) return;

  function tick() {
    var cur = state.commands[id];
    if (cur && isTerminal(cur.status)) { delete pollTimers[id]; return; }

    api.getCommand(id).then(function (res) {
      if (applyCommand(res.data)) emit();
    }, function () {
      // 单次失败不中断
    }).then(function () {
      var c = state.commands[id];
      if (c && isTerminal(c.status)) { delete pollTimers[id]; return; }
      if (c && Date.now() > c.expires_at_ms + 3000) { delete pollTimers[id]; return; }
      pollTimers[id] = setTimeout(tick, 2000);
    });
  }

  pollTimers[id] = setTimeout(tick, 1200);
}

function sendPower(deviceId, endpoint, property, next) {
  var key = deviceId + ":" + endpoint + ":" + property;
  state.pending[key] = next;
  emit();

  // 契约：Idempotency-Key 必填，重试需复用同一个键
  var idemKey = fmt.uuid();

  return api.createCommand(deviceId, {
    endpoint: endpoint,
    action: "set_power",
    params: { power: next },
    timeout_ms: 5000
  }, idemKey).then(function (res) {
    applyCommand(res.data);
    delete state.pending[key];
    emit();
    watchCommand(res.data.command_id);
    return res.data;
  }, function (err) {
    delete state.pending[key];
    emit();
    throw err;
  });
}

/* ---------------- 实时通知 ---------------- */

function onNotification(n) {
  if (!n || n.schema_version !== 1) return;

  if (n.type === "device.state_changed") {
    if (applyDevice(n.data)) emit();
    return;
  }
  if (n.type === "gateway.status_changed") {
    if (applyGateway(n.data)) emit();
    return;
  }
  if (n.type === "command.updated") {
    if (applyCommand(n.data)) emit();
  }
}

function setWsStatus(s, detail) {
  state.wsStatus = s;
  state.wsDetail = detail || "";
  emit();
}

function commandsOf(deviceId) {
  var out = [];
  Object.keys(state.commands).forEach(function (id) {
    var c = state.commands[id];
    if (c.device_id === deviceId) out.push(c);
  });
  out.sort(function (a, b) { return b.updated_at_ms - a.updated_at_ms; });
  return out.slice(0, 6);
}

module.exports = {
  state: state,
  getState: getState,
  subscribe: subscribe,
  loadSnapshot: loadSnapshot,
  loadEvents: loadEvents,
  selectDevice: selectDevice,
  findDevice: findDevice,
  sendPower: sendPower,
  onNotification: onNotification,
  setWsStatus: setWsStatus,
  commandsOf: commandsOf,
  isTerminal: isTerminal,
  RANK: RANK
};
