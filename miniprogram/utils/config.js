/**
 * 全局配置：换服务器只改这里
 */
var DEFAULT_API_BASE = "http://39.107.159.76:8000/api/v1";
var DEFAULT_TOKEN = "tinygate-demo-token";

function getApiBase() {
  return wx.getStorageSync("tg.apiBase") || DEFAULT_API_BASE;
}

function getToken() {
  return wx.getStorageSync("tg.token") || DEFAULT_TOKEN;
}

function save(patch) {
  if (patch.apiBase) wx.setStorageSync("tg.apiBase", patch.apiBase);
  if (patch.token !== undefined) wx.setStorageSync("tg.token", patch.token);
}

/** http(s) -> ws(s)，拼上 /ws */
function wsUrl() {
  var base = getApiBase().replace(/\/$/, "");
  return base.replace(/^http/, "ws") + "/ws";
}

module.exports = {
  DEFAULT_API_BASE: DEFAULT_API_BASE,
  DEFAULT_TOKEN: DEFAULT_TOKEN,
  getApiBase: getApiBase,
  getToken: getToken,
  save: save,
  wsUrl: wsUrl
};
