var store = require("./utils/store");
var realtime = require("./utils/realtime");

App({
  onLaunch: function () {
    var lastIds = "";

    // 网关列表变化后重新订阅（契约：每次 subscribe 替换原订阅）
    store.subscribe(function (s) {
      var ids = s.gateways.map(function (g) { return g.gateway_id; });
      var joined = ids.join(",");
      if (joined && joined !== lastIds) {
        lastIds = joined;
        realtime.resubscribe(ids);
      }
    });

    // 启动即建立实时通道，页面切换不中断
    realtime.start({
      getGatewayIds: function () {
        return store.state.gateways.map(function (g) { return g.gateway_id; });
      },
      onStatus: function (s, detail) {
        store.setWsStatus(s, detail);
      },
      onNotification: function (n) {
        store.onNotification(n);
      },
      onReady: function () {
        // 契约：订阅确认后再回查 HTTP 快照
        store.loadSnapshot().then(function () {
          var ids = store.state.gateways.map(function (g) { return g.gateway_id; });
          if (ids.length) realtime.resubscribe(ids);
        }, function () {});
      }
    });
  },

  globalData: {
    store: store
  }
});
