/* HTTP 访问层
 * 对照 contracts/openapi.yaml：统一包裹 {data, request_id}，
 * 错误统一为 {error:{code,message,details?}, request_id}，code 为字符串枚举。
 */
TG.api = (function () {
  let lastRequestId = null;

  async function request(path, opts) {
    opts = opts || {};

    if (TG.config.useMock) {
      const res = await TG.mock.request(opts.method || "GET", path, opts);
      lastRequestId = res.request_id;
      return res;
    }

    const headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (TG.config.token) headers.Authorization = "Bearer " + TG.config.token;
    // 契约：POST 创建命令必须带 Idempotency-Key
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const res = await fetch(TG.config.apiBase.replace(/\/$/, "") + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (e) {
      payload = null;
    }

    lastRequestId = payload && payload.request_id ? payload.request_id : null;

    if (!res.ok) {
      const err = (payload && payload.error) || {
        code: "INTERNAL_ERROR",
        message: "HTTP " + res.status,
      };
      const e = new Error(err.message || err.code);
      e.code = err.code;
      e.details = err.details;
      e.status = res.status;
      e.requestId = lastRequestId;
      throw e;
    }

    return payload;
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    });
    const s = p.toString();
    return s ? "?" + s : "";
  }

  return {
    lastRequestId: () => lastRequestId,

    listGateways: (params) => request("/gateways" + qs(params)),

    getGateway: (id) => request("/gateways/" + encodeURIComponent(id)),

    listDevices: (params) => request("/devices" + qs(params)),

    getDevice: (id) => request("/devices/" + encodeURIComponent(id)),

    listEvents: (deviceId, params) =>
      request("/devices/" + encodeURIComponent(deviceId) + "/events" + qs(params)),

    getCommand: (id) => request("/commands/" + encodeURIComponent(id)),

    /* 创建即时控制命令
     * 同一 idempotencyKey 重试会拿回原命令；返回 202 只代表已受理。
     */
    createCommand: (deviceId, body, idempotencyKey) =>
      request("/devices/" + encodeURIComponent(deviceId) + "/commands", {
        method: "POST",
        body: body,
        idempotencyKey: idempotencyKey,
      }),
  };
})();
