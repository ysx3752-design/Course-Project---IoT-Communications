/* 应用层：状态合并与渲染
 * 关键契约点都标了出处，便于对照 contracts/ 复核。
 */
TG.app = (function () {
  const T = TG.util;
  const $ = (id) => document.getElementById(id);

  const TERMINAL = new Set(["succeeded", "failed", "expired"]);
  const RANK = { queued: 1, dispatched: 2, accepted: 3, succeeded: 4, failed: 5, expired: 5 };
  const STATUS_TEXT = {
    queued: "已受理",
    dispatched: "已下发",
    accepted: "网关已接收",
    succeeded: "执行成功",
    failed: "执行失败",
    expired: "已过期",
  };

  const state = {
    gateways: [],
    devices: [],
    commands: new Map(),
    events: [],
    selectedDeviceId: null,
    pending: new Set(),
    wsStatus: "idle",
  };

  const pollTimers = new Map();

  /* ---------------- 日志与提示 ---------------- */

  function log(level, text) {
    const list = $("logList");
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const t = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const line = document.createElement("div");
    line.innerHTML = `<span class="t">${t}</span><span class="${level}">${T.esc(text)}</span>`;
    list.appendChild(line);
    while (list.children.length > 200) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  let toastTimer = null;
  function toast(text, ok) {
    const node = $("toast");
    node.textContent = text;
    node.className = "toast" + (ok ? " ok" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add("hidden"), 3600);
  }

  function toastError(e) {
    const code = e && e.code ? e.code : "UNKNOWN";
    const rid = e && e.requestId ? " · " + e.requestId : "";
    toast(code + "：" + (e.message || "") + rid, false);
    log("err", `错误 ${code} · ${e.message || ""}${rid}`);
  }

  /* ---------------- 状态合并（修订号规则） ---------------- */

  function applyGateway(snap) {
    const i = state.gateways.findIndex((g) => g.gateway_id === snap.gateway_id);
    if (i >= 0 && state.gateways[i].state_revision >= snap.state_revision) return false;
    if (i >= 0) state.gateways[i] = snap;
    else state.gateways.push(snap);
    return true;
  }

  function applyDevice(snap) {
    const i = state.devices.findIndex((d) => d.device_id === snap.device_id);
    // 契约：只应用更高修订号，同号忽略
    if (i >= 0 && state.devices[i].state_revision >= snap.state_revision) return false;
    if (i >= 0) state.devices[i] = snap;
    else state.devices.push(snap);
    return true;
  }

  function applyCommand(cmd) {
    const cur = state.commands.get(cmd.command_id);
    if (cur) {
      // 契约：终态不可变
      if (TERMINAL.has(cur.status)) return false;
      // 契约：只应用更高 command_revision
      if (cmd.command_revision <= cur.command_revision) return false;
      // 契约：禁止状态倒退
      if (RANK[cmd.status] < RANK[cur.status]) return false;
    }
    state.commands.set(cmd.command_id, cmd);
    return true;
  }

  /* ---------------- 渲染 ---------------- */

  function renderGateways() {
    $("gatewayCount").textContent = state.gateways.length;
    $("gatewayList").innerHTML = state.gateways
      .map(
        (g) => `
      <div class="item">
        <div class="item-top">
          <span class="item-name"><i class="dot ${g.online ? "on" : ""}"></i>${T.esc(g.name)}</span>
          <span class="tag">${g.online ? "在线" : "离线"}</span>
        </div>
        <div class="item-meta">
          <span class="item-id">${T.esc(g.gateway_id)}</span>
          <span>固件 ${T.esc(g.firmware_version)}</span>
        </div>
        <div class="item-meta">
          <span>心跳 ${T.fmtAgo(g.last_seen_at_ms)}</span>
        </div>
      </div>`
      )
      .join("") || `<div class="item"><span class="item-id">暂无网关</span></div>`;
  }

  function unitLabel(u) {
    if (!u) return "";
    if (u === "degC") return "℃";
    if (u === "percent") return "%";
    return u;
  }

  function keyValueOf(dev) {
    const eps = Object.keys(dev.reported_state || {});
    if (!eps.length) return null;
    const ep = eps[0];
    const props = dev.reported_state[ep];
    const name = Object.keys(props)[0];
    if (!name) return null;
    const val = props[name];
    const cap = (dev.capabilities[ep] && dev.capabilities[ep].properties[name]) || {};
    let text;
    if (typeof val === "boolean") text = val ? "开启" : "关闭";
    else text = `${val}${cap.unit ? " " + unitLabel(cap.unit) : ""}`;
    return { name, text };
  }

  function renderDevices() {
    $("deviceCount").textContent = state.devices.length;
    $("deviceList").innerHTML =
      state.devices
        .map((d) => {
          const active = d.device_id === state.selectedDeviceId ? " active" : "";
          const kv = keyValueOf(d);
          return `
        <div class="item${active}" data-device="${T.esc(d.device_id)}">
          <div class="item-top">
            <span class="item-name"><i class="dot ${d.online ? "on" : ""}"></i>${T.esc(d.name)}</span>
            <span class="tag ${d.protocol}">${d.protocol}</span>
          </div>
          <div class="item-meta">
            ${kv ? `<span class="val-chip">${T.esc(kv.name)} ${T.esc(kv.text)}</span>` : ""}
            <span>${d.online ? "在线" : "离线"}</span>
            <span>${T.fmtAgo(d.last_seen_at_ms)}</span>
          </div>
          <div class="item-id">${T.esc(d.device_id)}</div>
        </div>`;
        })
        .join("") || `<div class="item"><span class="item-id">暂无设备</span></div>`;
  }

  function currentDevice() {
    return state.devices.find((d) => d.device_id === state.selectedDeviceId) || null;
  }

  function renderDetail() {
    const dev = currentDevice();
    if (!dev) {
      $("emptyState").classList.remove("hidden");
      $("devicePanel").classList.add("hidden");
      return;
    }
    $("emptyState").classList.add("hidden");
    $("devicePanel").classList.remove("hidden");

    $("devName").textContent = dev.name;
    $("devMeta").textContent = `${dev.device_id} · ${dev.gateway_id} · ${dev.protocol} · 最近活动 ${T.fmtAgo(
      dev.last_seen_at_ms
    )}`;

    const badge = $("devOnline");
    badge.textContent = dev.online ? "在线" : "离线";
    badge.className = "badge " + (dev.online ? "on" : "off");

    renderHero(dev);
    renderStateTable(dev);
    renderCommands();
    renderSummary();
  }

  /* 主控区：v1 唯一可执行动作 set_power 放大成主按钮；只读设备则突出当前读数 */
  function renderHero(dev) {
    const host = $("heroControl");

    let target = null;
    Object.keys(dev.capabilities || {}).forEach((ep) => {
      const cap = dev.capabilities[ep];
      Object.keys(cap.properties || {}).forEach((name) => {
        const p = cap.properties[name];
        const controllable = p.writable && p.type === "boolean" && (cap.actions || []).includes("set_power");
        if (controllable && !target) target = { ep, name, cap };
      });
    });

    if (target) {
      const cur = dev.reported_state && dev.reported_state[target.ep]
        ? dev.reported_state[target.ep][target.name]
        : undefined;
      const pendingKey = `${dev.device_id}:${target.ep}:${target.name}`;
      const busy = state.pending.has(pendingKey) || !dev.online;

      host.innerHTML = `
        <div class="ctrl">
          <div class="ctrl-text">
            <span class="ctrl-label">${T.esc(target.name)} · 端点 ${T.esc(target.ep)}</span>
            <span class="ctrl-state ${cur ? "on" : "off"}">${cur ? "已开启" : "已关闭"}</span>
          </div>
          <button class="switch ${cur ? "on" : ""}" data-toggle="1"
            data-dev="${T.esc(dev.device_id)}" data-ep="${T.esc(target.ep)}" data-prop="${T.esc(target.name)}"
            data-next="${cur ? "0" : "1"}" ${busy ? "disabled" : ""}
            aria-label="${cur ? "关闭" : "开启"}"
            title="${dev.online ? (cur ? "点击关闭" : "点击开启") : "设备离线，无法控制"}"></button>
        </div>`;
      return;
    }

    // 只读设备：突出最重要的读数
    const kv = keyValueOf(dev);
    if (!kv) {
      host.innerHTML = `<span class="unsupported">该设备暂无可展示状态</span>`;
      return;
    }
    const epKeys = Object.keys(dev.reported_state);
    const ep = epKeys[0];
    const raw = dev.reported_state[ep][kv.name];
    const cap = (dev.capabilities[ep] && dev.capabilities[ep].properties[kv.name]) || {};
    const num = typeof raw === "number" ? raw : String(raw);

    host.innerHTML = `
      <div class="readout">
        <div><span class="num">${T.esc(num)}</span><span class="unit">${T.esc(unitLabel(cap.unit))}</span></div>
        <span class="label">${T.esc(kv.name)} · 端点 ${T.esc(ep)}</span>
      </div>`;
  }

  function renderSummary() {
    const gwOn = state.gateways.filter((g) => g.online).length;
    const devOn = state.devices.filter((d) => d.online).length;
    const running = Array.from(state.commands.values()).filter((c) => !TERMINAL.has(c.status)).length;

    $("statGw").textContent = `${gwOn}/${state.gateways.length}`;
    $("statDev").textContent = `${devOn}/${state.devices.length}`;
    $("statCmd").textContent = String(running);
    $("statEvt").textContent = String(state.events.length);
  }

  function renderStateTable(dev) {
    const rows = [];
    Object.keys(dev.reported_state || {}).forEach((ep) => {
      const props = dev.reported_state[ep];
      Object.keys(props).forEach((name) => {
        const cap = (dev.capabilities[ep] && dev.capabilities[ep].properties[name]) || {};
        rows.push(`<tr>
          <td class="mono">${T.esc(ep)}</td>
          <td class="mono">${T.esc(name)}</td>
          <td class="mono">${T.esc(props[name])}${cap.unit ? " " + T.esc(unitLabel(cap.unit)) : ""}</td>
          <td class="mono">${T.esc(cap.type || "—")}</td>
        </tr>`);
      });
    });
    $("stateBody").innerHTML = rows.join("") || `<tr><td colspan="4" class="empty-cell">暂无状态</td></tr>`;
  }

  function flowHtml(status) {
    const steps = ["queued", "dispatched", "accepted", "succeeded"];
    const cur = RANK[status] || 1;
    const dead = status === "failed" || status === "expired";
    return (
      `<div class="flow">` +
      steps
        .map((s) => {
          const done = RANK[s] < cur && !dead;
          const isNow = s === status;
          return `<span class="${done ? "done" : ""} ${isNow ? "now" : ""}">${s}</span>`;
        })
        .join("") +
      (dead ? `<span class="now">${status}</span>` : "") +
      `</div>`
    );
  }

  function renderCommands() {
    const dev = currentDevice();
    if (!dev) return;
    const list = Array.from(state.commands.values())
      .filter((c) => c.device_id === dev.device_id)
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
      .slice(0, 6);

    if (!list.length) {
      $("commandList").innerHTML = `<p class="unsupported">还没有命令，点击上方开关下发一条 set_power</p>`;
      return;
    }

    $("commandList").innerHTML = list
      .map((c) => {
        const err =
          c.error && c.error.code
            ? `<div class="cmd-err">${T.esc(c.error.code)} · ${T.esc(c.error.message || "")}</div>`
            : "";
        const rs =
          c.reported_state && c.reported_state.power !== undefined
            ? ` · 反馈 power=${c.reported_state.power}`
            : "";
        return `<div class="cmd">
          <div class="cmd-head">
            <span class="cmd-id">${T.esc(c.command_id)}</span>
            <span class="st ${c.status}">${STATUS_TEXT[c.status] || c.status}</span>
          </div>
          <div class="cmd-body">
            <code>${T.esc(c.action)}</code> endpoint ${T.esc(c.endpoint)} ·
            power=${T.esc(c.params.power)}${T.esc(rs)}
          </div>
          ${flowHtml(c.status)}
          ${err}
        </div>`;
      })
      .join("");
  }

  function eventSummary(e) {
    const d = e.data || {};
    if (e.type === "property_reported") return `${d.endpoint}.${d.property} = ${d.value}`;
    if (e.type === "device_presence") return `online = ${d.online}`;
    if (e.type === "alarm") return `${d.code} · ${d.message || ""}`;
    return JSON.stringify(d);
  }

  function renderEvents() {
    $("eventBody").innerHTML =
      state.events
        .map(
          (e) => `<tr>
        <td class="mono">${T.fmtTime(e.received_at_ms)}</td>
        <td class="mono">${T.esc(e.type)}</td>
        <td class="mono">${T.esc(eventSummary(e))}</td>
        <td class="mono">${e.replayed ? "是" : "否"}</td>
      </tr>`
        )
        .join("") || `<tr><td colspan="4" class="empty-cell">暂无事件</td></tr>`;
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadSnapshot() {
    const gw = await TG.api.listGateways({ limit: 100 });
    state.gateways = gw.data.items || [];
    const dv = await TG.api.listDevices({ limit: 100 });
    state.devices = dv.data.items || [];
    renderGateways();
    renderDevices();
    renderSummary();
    if (!state.selectedDeviceId && state.devices.length) {
      state.selectedDeviceId = state.devices[0].device_id;
      await selectDevice(state.selectedDeviceId);
    } else {
      renderDetail();
    }
  }

  async function selectDevice(id) {
    state.selectedDeviceId = id;
    renderDevices();
    renderDetail();
    state.events = [];
    renderEvents();
    try {
      const res = await TG.api.listEvents(id, { limit: 20 });
      if (state.selectedDeviceId === id) {
        state.events = res.data.items || [];
        renderEvents();
        renderSummary();
      }
    } catch (e) {
      log("err", `加载事件失败 ${e.code || ""}`);
    }
  }

  /* ---------------- 命令下发 ---------------- */

  async function sendPower(devId, ep, prop, next) {
    const dev = state.devices.find((d) => d.device_id === devId);
    if (!dev) return;

    const pendingKey = `${devId}:${ep}:${prop}`;
    state.pending.add(pendingKey);
    renderHero(dev);

    // 契约：Idempotency-Key 必填，重试需复用同一个键
    const key = T.uuid();

    try {
      const res = await TG.api.createCommand(
        devId,
        {
          endpoint: ep,
          action: "set_power",
          params: { power: next },
          timeout_ms: 5000,
        },
        key
      );
      log("ok", `POST /devices/${devId}/commands → 202 ${res.data.command_id} (key ${key.slice(0, 8)}…)`);
      applyCommand(res.data);
      renderCommands();
      watchCommand(res.data.command_id);
    } catch (e) {
      toastError(e);
    } finally {
      state.pending.delete(pendingKey);
      const still = state.devices.find((d) => d.device_id === devId);
      if (still) renderHero(still);
    }
  }

  // 契约：202 不代表执行成功，需等 command.updated 或轮询 GET /commands/{id}
  function watchCommand(id) {
    if (pollTimers.has(id)) return;

    const tick = async () => {
      const cur = state.commands.get(id);
      if (cur && TERMINAL.has(cur.status)) {
        pollTimers.delete(id);
        return;
      }
      try {
        const res = await TG.api.getCommand(id);
        if (applyCommand(res.data)) renderCommands();
      } catch (e) {
        /* 轮询失败不打断，下一轮继续 */
      }
      const c = state.commands.get(id);
      if (c && TERMINAL.has(c.status)) {
        pollTimers.delete(id);
        return;
      }
      if (c && Date.now() > c.expires_at_ms + 3000) {
        log("warn", `${id} 超过有效期仍无终态`);
        pollTimers.delete(id);
        return;
      }
      pollTimers.set(id, setTimeout(tick, 2000));
    };

    pollTimers.set(id, setTimeout(tick, 1200));
  }

  /* ---------------- 实时通知 ---------------- */

  function onNotification(n) {
    if (!n || n.schema_version !== 1) return;

    if (n.type === "device.state_changed") {
      if (applyDevice(n.data)) {
        renderDevices();
        renderDetail();
        log("ok", `device.state_changed ${n.data.device_id} rev ${n.data.state_revision}`);
      }
      return;
    }

    if (n.type === "gateway.status_changed") {
      if (applyGateway(n.data)) {
        renderGateways();
        renderSummary();
        log("ok", `gateway.status_changed ${n.data.gateway_id} rev ${n.data.state_revision}`);
      }
      return;
    }

    if (n.type === "command.updated") {
      if (applyCommand(n.data)) {
        renderCommands();
        renderSummary();
        const c = n.data;
        const lvl = c.status === "succeeded" ? "ok" : TERMINAL.has(c.status) ? "warn" : "info";
        log(lvl, `command.updated ${c.command_id} → ${c.status}`);
        if (c.status === "expired") toast("未确认执行结果（命令已过期）", false);
      }
    }
  }

  function onStatus(s, detail) {
    state.wsStatus = s;
    const pill = $("wsPill");
    const text = $("wsPillText");
    const map = {
      idle: ["", "WSS 未连接"],
      connecting: ["warn", "WSS 连接中"],
      authenticating: ["warn", "WSS 鉴权中"],
      subscribing: ["warn", "WSS 订阅中"],
      ready: ["ok", "WSS 已就绪"],
      closed: ["warn", detail || "WSS 已断开"],
      error: ["err", "WSS " + (detail || "异常")],
    };
    const [cls, label] = map[s] || ["", "WSS " + s];
    pill.className = "pill " + cls;
    text.textContent = label;
    if (s === "ready") log("ok", "WSS 握手完成：authenticated → subscribed");
  }

  /* ---------------- 交互绑定 ---------------- */

  function bind() {
    $("deviceList").addEventListener("click", (e) => {
      const item = e.target.closest("[data-device]");
      if (item) selectDevice(item.dataset.device);
    });

    $("heroControl").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-toggle]");
      if (!btn || btn.disabled) return;
      sendPower(btn.dataset.dev, btn.dataset.ep, btn.dataset.prop, btn.dataset.next === "1");
    });

    $("btnRefresh").addEventListener("click", async () => {
      try {
        await loadSnapshot();
        if (state.selectedDeviceId) await selectDevice(state.selectedDeviceId);
        log("ok", "已刷新快照");
      } catch (e) {
        toastError(e);
      }
    });

    $("btnClearLog").addEventListener("click", () => {
      $("logList").innerHTML = "";
    });

    $("sourceSelect").addEventListener("change", (e) => {
      TG.config.save({ useMock: e.target.value === "mock" });
      location.reload();
    });

    $("btnSettings").addEventListener("click", () => {
      $("inputApiBase").value = TG.config.apiBase;
      $("inputToken").value = TG.config.token;
      $("settingsModal").classList.remove("hidden");
    });

    $("btnCloseSettings").addEventListener("click", () => {
      $("settingsModal").classList.add("hidden");
    });

    $("btnSaveSettings").addEventListener("click", () => {
      TG.config.save({
        apiBase: $("inputApiBase").value.trim() || TG.config.apiBase,
        token: $("inputToken").value.trim(),
      });
      location.reload();
    });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    $("sourceSelect").value = TG.config.useMock ? "mock" : "real";

    const apiPill = $("apiPill");
    if (TG.config.useMock) {
      apiPill.className = "pill ok";
      $("apiPillText").textContent = "HTTP 模拟数据";
    } else {
      apiPill.className = "pill ok";
      $("apiPillText").textContent = "HTTP " + TG.config.apiBase.replace(/^https?:\/\//, "");
      if (!TG.config.token) {
        apiPill.className = "pill err";
        $("apiPillText").textContent = "HTTP 缺少令牌";
      }
    }

    bind();
    log("info", TG.config.useMock ? "数据源：内置模拟器（无需后端即可演示）" : "数据源：真实后端 " + TG.config.apiBase);

    try {
      await loadSnapshot();
    } catch (e) {
      toastError(e);
      log("err", "初始快照加载失败，检查后端地址与令牌");
    }

    TG.realtime.start({
      getToken: () => TG.config.token || "mock-token",
      getGatewayIds: () => state.gateways.map((g) => g.gateway_id),
      onStatus: onStatus,
      onNotification: onNotification,
      onReady: async () => {
        // 契约：订阅确认后再回查 HTTP 快照
        try {
          await loadSnapshot();
        } catch (e) {
          /* 快照回查失败不阻断实时通道 */
        }
      },
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  return { init, state };
})();
