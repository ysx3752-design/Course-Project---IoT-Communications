/* 模拟数据源
 * 严格按 contracts/schemas/messages.schema.json 的字段生成报文，
 * 并把 examples/scenarios.json 里的关键场景（离线 409、超时、重复请求）做进演示路径。
 */
TG.mock = (function () {
  const T = TG.util;
  const listeners = new Set();

  let reqSeq = 0;
  let cmdSeq = 0;
  let evtSeq = 0;
  const rid = () => "req_mock_" + String(++reqSeq).padStart(4, "0");
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const bootCounter = 7;
  const bootId = "boot_0007";
  const bootAt = Date.now() - 1000 * 60 * 60 * 3;

  /* ---------------- 网关与设备 ---------------- */

  const gateways = [
    {
      gateway_id: "gw_01",
      name: "网关一号",
      online: true,
      last_seen_at_ms: Date.now(),
      firmware_version: "0.1.0",
      state_revision: 120,
    },
    {
      gateway_id: "gw_02",
      name: "网关二号",
      online: true,
      last_seen_at_ms: Date.now() - 17000,
      firmware_version: "0.1.0",
      state_revision: 34,
    },
  ];

  const controlCap = {
    1: {
      properties: { power: { type: "boolean", readable: true, writable: true } },
      actions: ["set_power"],
    },
  };

  const sensorCap = {
    10: {
      properties: { temperature: { type: "number", readable: true, writable: false, unit: "degC" } },
      actions: [],
    },
  };

  const devices = [
    {
      device_id: "actuator_01",
      gateway_id: "gw_01",
      name: "模拟灯一",
      protocol: "ble",
      online: true,
      last_seen_at_ms: Date.now(),
      capabilities: controlCap,
      reported_state: { 1: { power: false } },
      state_revision: 42,
    },
    {
      device_id: "actuator_02",
      gateway_id: "gw_01",
      name: "模拟灯二",
      protocol: "ble",
      online: true,
      last_seen_at_ms: Date.now(),
      capabilities: controlCap,
      reported_state: { 1: { power: false } },
      state_revision: 42,
    },
    {
      device_id: "actuator_03",
      gateway_id: "gw_01",
      name: "模拟灯三（离线）",
      protocol: "ble",
      online: false,
      last_seen_at_ms: Date.now() - 1000 * 60 * 12,
      capabilities: controlCap,
      reported_state: { 1: { power: false } },
      state_revision: 18,
    },
    {
      device_id: "sensor_01",
      gateway_id: "gw_01",
      name: "温度传感器一",
      protocol: "zigbee",
      online: true,
      last_seen_at_ms: Date.now() - 4000,
      capabilities: sensorCap,
      reported_state: { 10: { temperature: 24.6 } },
      state_revision: 88,
    },
    {
      device_id: "sensor_02",
      gateway_id: "gw_02",
      name: "温度传感器二",
      protocol: "zigbee",
      online: true,
      last_seen_at_ms: Date.now() - 9000,
      capabilities: sensorCap,
      reported_state: { 10: { temperature: 21.2 } },
      state_revision: 27,
    },
  ];

  /* ---------------- 事件存储 ---------------- */

  const events = new Map(); // device_id -> StoredEvent[]

  function makeEvent(dev, type, data, opts) {
    opts = opts || {};
    const seq = ++evtSeq;
    const occurred = opts.occurred !== undefined ? opts.occurred : Date.now();
    const received = opts.received !== undefined ? opts.received : occurred;
    return {
      schema_version: 1,
      event_id: dev.gateway_id + ":" + bootId + ":" + seq,
      gateway_id: dev.gateway_id,
      device_id: dev.device_id,
      boot_id: bootId,
      boot_counter: bootCounter,
      seq: seq,
      type: type,
      occurred_at_ms: occurred,
      uptime_ms: Math.max(0, occurred - bootAt),
      replayed: !!opts.replayed,
      data: data,
      received_at_ms: received,
    };
  }

  function pushEvent(dev, ev) {
    const arr = events.get(dev.device_id) || [];
    arr.push(ev);
    events.set(dev.device_id, arr);
  }

  function seedEvents() {
    const base = Date.now() - 1000 * 60 * 20;
    devices.forEach((dev) => {
      if (dev.protocol === "zigbee") {
        const ep = Object.keys(dev.capabilities)[0];
        let v = dev.reported_state[ep].temperature - 1.2;
        for (let i = 0; i < 18; i++) {
          v = Math.round((v + (Math.random() - 0.45) * 0.6) * 10) / 10;
          const at = base + i * 60000;
          pushEvent(
            dev,
            makeEvent(dev, "property_reported", { endpoint: ep, property: "temperature", value: v }, {
              occurred: at,
              received: at + 120,
            })
          );
        }
      }
      if (dev.protocol === "ble") {
        pushEvent(
          dev,
          makeEvent(dev, "device_presence", { online: dev.online }, {
            occurred: Date.now() - 1000 * 60 * 5,
            received: Date.now() - 1000 * 60 * 5,
          })
        );
      }
    });
  }

  seedEvents();

  /* ---------------- 命令 ---------------- */

  const commands = new Map();
  const idemIndex = new Map(); // key -> {fingerprint, command_id}

  function fingerprint(deviceId, body) {
    return JSON.stringify([deviceId, body.endpoint, body.action, body.params]);
  }

  function emit(n) {
    listeners.forEach((fn) => {
      try {
        fn(n);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function bumpDevice(dev) {
    dev.state_revision += 1;
    dev.last_seen_at_ms = Date.now();
    emit({ schema_version: 1, type: "device.state_changed", data: clone(dev) });
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function setCommandStatus(cmd, status, patch) {
    if (cmd.status === "succeeded" || cmd.status === "failed" || cmd.status === "expired") return cmd;
    cmd.status = status;
    cmd.updated_at_ms = Date.now();
    cmd.command_revision += 1;
    if (patch) Object.assign(cmd, patch);
    emit({ schema_version: 1, type: "command.updated", data: clone(cmd) });
    return cmd;
  }

  function runCommand(cmd, dev) {
    const remain = Math.max(80, cmd.expires_at_ms - Date.now());
    const step = (ratio) => Math.max(60, Math.round(remain * ratio));

    setTimeout(() => setCommandStatus(cmd, "dispatched"), step(0.12));

    setTimeout(() => {
      if (cmd.status !== "dispatched" && cmd.status !== "queued") return;
      setCommandStatus(cmd, "accepted");
    }, step(0.3));

    setTimeout(() => {
      if (cmd.status === "succeeded" || cmd.status === "failed" || cmd.status === "expired") return;

      if (Date.now() > cmd.expires_at_ms) {
        setCommandStatus(cmd, "expired", {
          error: { code: "COMMAND_EXPIRED", message: "命令到期仍未收到设备确认" },
        });
        return;
      }

      // 约 12% 概率演示执行失败（对应 DEVICE_TIMEOUT）
      if (Math.random() < 0.12) {
        setCommandStatus(cmd, "failed", {
          error: { code: "DEVICE_TIMEOUT", message: "设备未在 timeout_ms 内响应" },
        });
        return;
      }

      const power = !!cmd.params.power;
      setCommandStatus(cmd, "succeeded", { reported_state: { power: power } });

      // 设备实际状态由设备反馈驱动，命令受理阶段不得提前改写
      const ep = cmd.endpoint;
      dev.reported_state[ep] = Object.assign({}, dev.reported_state[ep], { power: power });
      bumpDevice(dev);

      pushEvent(
        dev,
        makeEvent(dev, "property_reported", { endpoint: ep, property: "power", value: power })
      );
    }, step(0.62));
  }

  /* ---------------- 路由 ---------------- */

  function fail(status, code, message) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.requestId = rid();
    return e;
  }

  function paged(items, qs) {
    const limit = Math.min(100, Math.max(1, parseInt(qs.get("limit") || "20", 10) || 20));
    const offset = parseInt(qs.get("cursor") || "0", 10) || 0;
    const slice = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? String(offset + limit) : null;
    return { data: { items: slice, next_cursor: next }, request_id: rid() };
  }

  async function request(method, path, opts) {
    opts = opts || {};
    await delay(60 + Math.random() * 100);

    const qi = path.indexOf("?");
    const qs = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : "");
    const p = qi >= 0 ? path.slice(0, qi) : path;
    const seg = p.split("/").filter(Boolean);

    // GET /gateways
    if (method === "GET" && seg.length === 1 && seg[0] === "gateways") {
      return paged(clone(gateways), qs);
    }

    // GET /gateways/{id}
    if (method === "GET" && seg.length === 2 && seg[0] === "gateways") {
      const g = gateways.find((x) => x.gateway_id === seg[1]);
      if (!g) throw fail(404, "NOT_FOUND", "网关不存在");
      return { data: clone(g), request_id: rid() };
    }

    // GET /devices
    if (method === "GET" && seg.length === 1 && seg[0] === "devices") {
      let list = devices;
      const gw = qs.get("gateway_id");
      if (gw) list = list.filter((d) => d.gateway_id === gw);
      return paged(clone(list), qs);
    }

    // GET /devices/{id}
    if (method === "GET" && seg.length === 2 && seg[0] === "devices") {
      const d = devices.find((x) => x.device_id === seg[1]);
      if (!d) throw fail(404, "NOT_FOUND", "设备不存在");
      return { data: clone(d), request_id: rid() };
    }

    // GET /devices/{id}/events
    if (method === "GET" && seg.length === 3 && seg[0] === "devices" && seg[2] === "events") {
      const d = devices.find((x) => x.device_id === seg[1]);
      if (!d) throw fail(404, "NOT_FOUND", "设备不存在");

      const from = qs.get("from_at_ms") ? parseInt(qs.get("from_at_ms"), 10) : null;
      const to = qs.get("to_at_ms") ? parseInt(qs.get("to_at_ms"), 10) : null;

      // 契约：时间筛选作用于 received_at_ms，from 闭区间、to 开区间
      let list = (events.get(d.device_id) || []).filter((e) => {
        if (from !== null && e.received_at_ms < from) return false;
        if (to !== null && e.received_at_ms >= to) return false;
        return true;
      });

      list.sort((a, b) =>
        b.received_at_ms !== a.received_at_ms
          ? b.received_at_ms - a.received_at_ms
          : (a.event_id < b.event_id ? 1 : -1)
      );

      return paged(clone(list), qs);
    }

    // POST /devices/{id}/commands
    if (method === "POST" && seg.length === 3 && seg[0] === "devices" && seg[2] === "commands") {
      const d = devices.find((x) => x.device_id === seg[1]);
      if (!d) throw fail(404, "NOT_FOUND", "设备不存在");

      // 契约：Idempotency-Key 必填
      const key = opts.idempotencyKey;
      if (!key) throw fail(400, "INVALID_ARGUMENT", "缺少 Idempotency-Key");

      const fp = fingerprint(d.device_id, opts.body || {});
      const hit = idemIndex.get(d.device_id + "|" + key);
      if (hit) {
        if (hit.fingerprint !== fp) {
          throw fail(409, "IDEMPOTENCY_CONFLICT", "同一 Idempotency-Key 对应了不同请求");
        }
        // 同键同请求：返回原命令，即使已终结，仍为 202
        return { data: clone(commands.get(hit.command_id)), request_id: rid(), status: 202 };
      }

      const body = opts.body || {};
      if (!body.endpoint || body.action !== "set_power" || !body.params || typeof body.params.power !== "boolean") {
        throw fail(400, "INVALID_ARGUMENT", "请求体不符合 CommandRequest");
      }

      // 契约：即时控制要求网关与设备同时在线，否则 409
      const gw = gateways.find((x) => x.gateway_id === d.gateway_id);
      if (!gw || !gw.online) throw fail(409, "GATEWAY_OFFLINE", "网关当前离线");
      if (!d.online) throw fail(409, "DEVICE_OFFLINE", "设备当前离线");

      const timeout = Math.min(30000, Math.max(100, body.timeout_ms || 5000));
      const t = Date.now();
      const cmd = {
        command_id: "cmd_" + String(++cmdSeq).padStart(4, "0"),
        gateway_id: d.gateway_id,
        device_id: d.device_id,
        endpoint: body.endpoint,
        action: body.action,
        params: { power: body.params.power },
        status: "queued",
        issued_at_ms: t,
        expires_at_ms: t + timeout,
        updated_at_ms: t,
        command_revision: 1,
        reported_state: null,
        error: null,
      };

      commands.set(cmd.command_id, cmd);
      idemIndex.set(d.device_id + "|" + key, { fingerprint: fp, command_id: cmd.command_id });
      runCommand(cmd, d);

      return { data: clone(cmd), request_id: rid(), status: 202 };
    }

    // GET /commands/{id}
    if (method === "GET" && seg.length === 2 && seg[0] === "commands") {
      const c = commands.get(seg[1]);
      if (!c) throw fail(404, "NOT_FOUND", "命令不存在");
      return { data: clone(c), request_id: rid() };
    }

    throw fail(404, "NOT_FOUND", "未实现的模拟路由：" + method + " " + p);
  }

  return {
    request: request,
    onNotification(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    gatewayIds() {
      return gateways.map((g) => g.gateway_id);
    },
  };
})();
