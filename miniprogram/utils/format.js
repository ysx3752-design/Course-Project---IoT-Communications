/** 展示层格式化工具 */

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function fmtTime(ms) {
  if (!ms) return "—";
  var d = new Date(ms);
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function fmtAgo(ms) {
  if (!ms) return "—";
  var s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

/** 契约里单位是 degC，展示成 ℃ */
function unitLabel(u) {
  if (!u) return "";
  if (u === "degC") return "℃";
  if (u === "percent") return "%";
  return u;
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 取第一个端点的第一个属性，用于列表页摘要 */
function keyValue(dev) {
  var eps = Object.keys(dev.reported_state || {});
  if (!eps.length) return null;
  var ep = eps[0];
  var props = dev.reported_state[ep];
  var names = Object.keys(props);
  if (!names.length) return null;
  var name = names[0];
  var val = props[name];
  var cap = (dev.capabilities && dev.capabilities[ep] && dev.capabilities[ep].properties[name]) || {};
  var text;
  if (typeof val === "boolean") text = val ? "开启" : "关闭";
  else text = val + (cap.unit ? " " + unitLabel(cap.unit) : "");
  return { endpoint: ep, name: name, value: val, text: text, unit: unitLabel(cap.unit) };
}

function eventText(e) {
  var d = e.data || {};
  if (e.type === "property_reported") return d.endpoint + "." + d.property + " = " + d.value;
  if (e.type === "device_presence") return "online = " + d.online;
  if (e.type === "alarm") return d.code + " " + (d.message || "");
  return JSON.stringify(d);
}

module.exports = {
  fmtTime: fmtTime,
  fmtAgo: fmtAgo,
  unitLabel: unitLabel,
  uuid: uuid,
  keyValue: keyValue,
  eventText: eventText
};
