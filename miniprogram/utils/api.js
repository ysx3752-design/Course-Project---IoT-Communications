/**
 * RESTful 访问层
 * 契约：contracts/openapi.yaml
 *  - 成功 { data, request_id }
 *  - 失败 { error: { code, message }, request_id }，code 是字符串枚举
 *  - POST 创建命令必须带 Idempotency-Key 请求头
 */
var config = require("./config");

function qs(params) {
  if (!params) return "";
  var parts = [];
  Object.keys(params).forEach(function (k) {
    var v = params[k];
    if (v === undefined || v === null || v === "") return;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  });
  return parts.length ? "?" + parts.join("&") : "";
}

function request(path, opt) {
  opt = opt || {};
  var header = { "content-type": "application/json" };
  var token = config.getToken();
  if (token) header.Authorization = "Bearer " + token;
  if (opt.idempotencyKey) header["Idempotency-Key"] = opt.idempotencyKey;

  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.getApiBase() + path,
      method: opt.method || "GET",
      header: header,
      data: opt.body,
      timeout: 10000,
      success: function (res) {
        var body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
          return;
        }
        var err = body.error || {};
        reject({
          code: err.code || "INTERNAL_ERROR",
          message: err.message || "HTTP " + res.statusCode,
          status: res.statusCode,
          requestId: body.request_id || ""
        });
      },
      fail: function (e) {
        reject({
          code: "NETWORK_ERROR",
          message: (e && e.errMsg) || "网络异常",
          status: 0,
          requestId: ""
        });
      }
    });
  });
}

module.exports = {
  listGateways: function (params) {
    return request("/gateways" + qs(params));
  },
  getGateway: function (id) {
    return request("/gateways/" + encodeURIComponent(id));
  },
  listDevices: function (params) {
    return request("/devices" + qs(params));
  },
  getDevice: function (id) {
    return request("/devices/" + encodeURIComponent(id));
  },
  listEvents: function (deviceId, params) {
    return request("/devices/" + encodeURIComponent(deviceId) + "/events" + qs(params));
  },
  getCommand: function (id) {
    return request("/commands/" + encodeURIComponent(id));
  },
  /** 返回 202 只代表受理；结果看推送或轮询 */
  createCommand: function (deviceId, body, idempotencyKey) {
    return request("/devices/" + encodeURIComponent(deviceId) + "/commands", {
      method: "POST",
      body: body,
      idempotencyKey: idempotencyKey
    });
  }
};
