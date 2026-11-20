/* 全局配置与工具函数
 * 契约依据：contracts/README.md 公共约定、openapi.yaml servers
 */
window.TG = window.TG || {};

// 从服务器同源打开时走相对路径；本地双击 index.html 时指向云端部署地址
function defaultApiBase() {
  if (location.protocol === "http:" || location.protocol === "https:") {
    return location.origin + "/api/v1";
  }
  return "http://39.107.159.76:8000/api/v1";
}

TG.config = {
  // v1 未定义登录接口（README 第 31 行），令牌需手工填入
  apiBase: localStorage.getItem("tg.apiBase") || defaultApiBase(),
  token: localStorage.getItem("tg.token") || "tinygate-demo-token",
  // 从服务器打开默认连真实后端；双击本地文件时默认用模拟数据
  useMock: (function () {
    const stored = localStorage.getItem("tg.useMock");
    if (stored !== null) return stored === "1";
    return location.protocol === "file:";
  })(),
  // realtime.md：wss://<部署域名>/api/v1/ws
  wsUrl() {
    const base = this.apiBase.replace(/^http/, "ws");
    return base.replace(/\/$/, "") + "/ws";
  },
  save(patch) {
    Object.assign(this, patch);
    localStorage.setItem("tg.apiBase", this.apiBase);
    localStorage.setItem("tg.token", this.token || "");
    localStorage.setItem("tg.useMock", this.useMock ? "1" : "0");
  },
};

TG.util = {
  // 契约要求 UUID/不透明 ID；file:// 下 randomUUID 可能不可用
  uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  },

  nowMs() {
    return Date.now();
  },

  // *_at_ms 为 UTC 毫秒，展示时转本地
  fmtTime(ms) {
    if (ms === null || ms === undefined) return "—";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },

  fmtAgo(ms) {
    if (!ms) return "—";
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 5) return "刚刚";
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  },

  esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },
};
