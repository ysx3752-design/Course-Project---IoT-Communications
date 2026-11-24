var store = require("../../utils/store");
var fmt = require("../../utils/format");

var WS_TEXT = {
  idle: "未连接",
  connecting: "连接中",
  authenticating: "鉴权中",
  subscribing: "订阅中",
  ready: "实时在线",
  closed: "已断开",
  error: "实时异常"
};

Page({
  data: {
    stats: { gw: "—", dev: "—", cmd: "0" },
    gateways: [],
    devices: [],
    wsText: "连接中",
    wsReady: false,
    apiHost: "",
    errText: ""
  },

  onLoad: function () {
    var that = this;
    this.unsub = store.subscribe(function () { that.render(); });
    this.setData({ apiHost: require("../../utils/config").getApiBase().replace(/^https?:\/\//, "") });
    this.render();
    store.loadSnapshot().catch(function (e) {
      that.setData({ errText: e.code || "加载失败" });
      wx.showToast({ title: (e.code || "加载失败") + "：" + (e.message || ""), icon: "none" });
    });
  },

  onUnload: function () {
    if (this.unsub) this.unsub();
  },

  onShow: function () {
    this.render();
  },

  onPullDownRefresh: function () {
    store.loadSnapshot().then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  render: function () {
    var s = store.state;
    var gwOn = s.gateways.filter(function (g) { return g.online; }).length;
    var devOn = s.devices.filter(function (d) { return d.online; }).length;
    var running = 0;
    Object.keys(s.commands).forEach(function (id) {
      if (!store.isTerminal(s.commands[id].status)) running += 1;
    });

    this.setData({
      stats: {
        gw: gwOn + "/" + s.gateways.length,
        dev: devOn + "/" + s.devices.length,
        cmd: String(running)
      },
      gateways: s.gateways.map(function (g) {
        return {
          id: g.gateway_id,
          name: g.name,
          online: g.online,
          fw: g.firmware_version,
          ago: fmt.fmtAgo(g.last_seen_at_ms)
        };
      }),
      devices: s.devices.map(function (d) {
        var kv = fmt.keyValue(d);
        return {
          id: d.device_id,
          name: d.name,
          online: d.online,
          proto: d.protocol,
          keyText: kv ? kv.name + " " + kv.text : "",
          ago: fmt.fmtAgo(d.last_seen_at_ms)
        };
      }),
      wsText: WS_TEXT[s.wsStatus] || s.wsStatus,
      wsReady: s.wsStatus === "ready",
      errText: s.lastError || ""
    });
  },

  goDevice: function (e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/device/device?device_id=" + encodeURIComponent(id) });
  }
});
