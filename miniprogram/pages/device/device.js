var store = require("../../utils/store");
var fmt = require("../../utils/format");

var STATUS_TEXT = {
  queued: "已受理",
  dispatched: "已下发",
  accepted: "网关已接收",
  succeeded: "执行成功",
  failed: "执行失败",
  expired: "已过期"
};
var STATUS_CLASS = {
  queued: "run",
  dispatched: "run",
  accepted: "run",
  succeeded: "ok",
  failed: "bad",
  expired: "bad"
};
var STEPS = ["queued", "dispatched", "accepted", "succeeded"];

Page({
  data: {
    ready: false,
    dev: null,
    control: { hasSwitch: false, on: false, disabled: true, label: "", stateText: "", value: "", unit: "" },
    states: [],
    commands: [],
    events: [],
    loading: true
  },

  onLoad: function (options) {
    var that = this;
    this.deviceId = decodeURIComponent((options && options.device_id) || "");
    this.unsub = store.subscribe(function () { that.render(); });
    store.selectDevice(this.deviceId);
    this.render();
    if (!store.findDevice(this.deviceId)) {
      store.loadSnapshot().then(function () { that.render(); }, function () {});
    }
  },

  onUnload: function () {
    if (this.unsub) this.unsub();
  },

  onPullDownRefresh: function () {
    var that = this;
    store.loadSnapshot().then(function () {
      return store.loadEvents(that.deviceId);
    }).then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  render: function () {
    var dev = store.findDevice(this.deviceId);
    if (!dev) {
      this.setData({ ready: false, loading: store.state.loading });
      return;
    }

    wx.setNavigationBarTitle({ title: dev.name });

    var control = this.buildControl(dev);
    var states = [];
    Object.keys(dev.reported_state || {}).forEach(function (ep) {
      var props = dev.reported_state[ep];
      Object.keys(props).forEach(function (name) {
        var cap = (dev.capabilities && dev.capabilities[ep] && dev.capabilities[ep].properties[name]) || {};
        states.push({
          key: ep + "-" + name,
          endpoint: ep,
          name: name,
          value: String(props[name]) + (cap.unit ? " " + fmt.unitLabel(cap.unit) : ""),
          type: cap.type || "—"
        });
      });
    });

    var cmds = store.commandsOf(dev.device_id).map(function (c) {
      var flow = STEPS.map(function (step) {
        var cls = "";
        var r = store.RANK[step];
        var cur = store.RANK[c.status] || 1;
        var dead = c.status === "failed" || c.status === "expired";
        if (r < cur && !dead) cls = "done";
        if (step === c.status) cls = "now";
        return { name: step, cls: cls };
      });
      if (c.status === "failed" || c.status === "expired") {
        flow.push({ name: c.status, cls: "now" });
      }
      return {
        id: c.command_id,
        status: c.status,
        statusText: STATUS_TEXT[c.status] || c.status,
        statusClass: STATUS_CLASS[c.status] || "",
        body: c.action + " · endpoint " + c.endpoint + " · power=" + c.params.power,
        errText: c.error && c.error.code ? c.error.code + " " + (c.error.message || "") : "",
        flow: flow
      };
    });

    var events = (store.state.events || []).map(function (e, i) {
      return {
        key: e.event_id || String(i),
        time: fmt.fmtTime(e.received_at_ms),
        type: e.type,
        text: fmt.eventText(e),
        replayed: !!e.replayed
      };
    });

    this.setData({
      ready: true,
      loading: false,
      dev: {
        id: dev.device_id,
        name: dev.name,
        online: dev.online,
        meta: dev.device_id + " · " + dev.gateway_id + " · " + dev.protocol,
        ago: fmt.fmtAgo(dev.last_seen_at_ms)
      },
      control: control,
      states: states,
      commands: cmds,
      events: events
    });
  },

  buildControl: function (dev) {
    var target = null;
    var caps = dev.capabilities || {};
    Object.keys(caps).forEach(function (ep) {
      var cap = caps[ep];
      var props = cap.properties || {};
      Object.keys(props).forEach(function (name) {
        var p = props[name];
        var controllable = p.writable && p.type === "boolean" &&
          (cap.actions || []).indexOf("set_power") >= 0;
        if (controllable && !target) target = { ep: ep, name: name, cap: cap, prop: p };
      });
    });

    if (target) {
      var actual = dev.reported_state && dev.reported_state[target.ep]
        ? dev.reported_state[target.ep][target.name] : false;
      var pendingKey = dev.device_id + ":" + target.ep + ":" + target.name;
      var pending = store.state.pending[pendingKey];
      var shown = pending === undefined ? !!actual : !!pending;
      this.ctrl = { ep: target.ep, name: target.name, on: shown, disabled: !dev.online };
      return {
        hasSwitch: true,
        on: shown,
        disabled: !dev.online,
        label: target.name + " · 端点 " + target.ep,
        stateText: !dev.online ? "设备离线" : (pending !== undefined ? "下发中…" : (shown ? "已开启" : "已关闭")),
        value: "",
        unit: ""
      };
    }

    var kv = fmt.keyValue(dev);
    this.ctrl = null;
    if (!kv) {
      return { hasSwitch: false, on: false, disabled: true, label: "", stateText: "", value: "—", unit: "" };
    }
    return {
      hasSwitch: false,
      on: false,
      disabled: true,
      label: kv.name + " · 端点 " + kv.endpoint,
      stateText: "",
      value: String(kv.value),
      unit: kv.unit || ""
    };
  },

  onToggle: function () {
    if (!this.ctrl || this.ctrl.disabled) return;
    var next = !this.ctrl.on;
    var that = this;
    store.sendPower(this.deviceId, this.ctrl.ep, this.ctrl.name, next).catch(function (err) {
      wx.showToast({
        title: (err.code || "失败") + "：" + (err.message || ""),
        icon: "none",
        duration: 2500
      });
      that.render();
    });
  }
});
