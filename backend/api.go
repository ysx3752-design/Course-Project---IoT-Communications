package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type API struct {
	store *Store
	hub   *Hub
	mq    *MQTT
	cfg   Config
}

func NewAPI(st *Store, hub *Hub, mq *MQTT, cfg Config) *API {
	return &API{store: st, hub: hub, mq: mq, cfg: cfg}
}

// ---------- 响应包裹 ----------

func writeData(w http.ResponseWriter, status int, data any) {
	jsonHeader(w)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"data":       data,
		"request_id": newRequestID(),
	})
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	jsonHeader(w)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":      ErrorBody{Code: code, Message: msg},
		"request_id": newRequestID(),
	})
}

func writeList(w http.ResponseWriter, status int, items any, nextCursor *string) {
	writeData(w, status, map[string]any{"items": items, "next_cursor": nextCursor})
}

// ---------- 游标 ----------

func encCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("o:" + strconv.Itoa(offset)))
}

func decCursor(s string) (int, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || !strings.HasPrefix(string(raw), "o:") {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(string(raw), "o:"))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

func encEventCursor(ms int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte("k:" + strconv.FormatInt(ms, 10) + ":" + id))
}

func decEventCursor(s string) (int64, string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, "", false
	}
	parts := strings.SplitN(string(raw), ":", 3)
	if len(parts) != 3 || parts[0] != "k" {
		return 0, "", false
	}
	ms, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, "", false
	}
	return ms, parts[2], true
}

func pageParams(r *http.Request) (int, int) {
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	offset := 0
	if c := r.URL.Query().Get("cursor"); c != "" {
		if n, ok := decCursor(c); ok {
			offset = n
		}
	}
	return limit, offset
}

// ---------- 中间件 ----------

func (a *API) withMiddleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			if allow := allowOrigin(a.cfg.CORSOrigins, origin); allow != "" {
				w.Header().Set("Access-Control-Allow-Origin", allow)
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key")
		w.Header().Set("Access-Control-Max-Age", "600")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic: %v %s %s", rec, r.Method, r.URL.Path)
				writeErr(w, 500, "INTERNAL_ERROR", "服务内部异常")
			}
		}()

		// WebSocket 用首帧 authenticate 鉴权（浏览器无法自定义握手头），其余 API 走 Bearer
		needAuth := strings.HasPrefix(r.URL.Path, "/api/v1") && r.URL.Path != "/api/v1/ws"
		if needAuth && a.cfg.Token != "" {
			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != a.cfg.Token {
				writeErr(w, 401, "UNAUTHENTICATED", "缺少或无效的访问令牌")
				return
			}
		}

		h.ServeHTTP(w, r)
	})
}

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("GET /api/v1/gateways", a.listGateways)
	mux.HandleFunc("GET /api/v1/gateways/{gateway_id}", a.getGateway)
	mux.HandleFunc("GET /api/v1/devices", a.listDevices)
	mux.HandleFunc("GET /api/v1/devices/{device_id}", a.getDevice)
	mux.HandleFunc("POST /api/v1/devices/{device_id}/commands", a.createCommand)
	mux.HandleFunc("GET /api/v1/devices/{device_id}/events", a.listEvents)
	mux.HandleFunc("GET /api/v1/commands/{command_id}", a.getCommand)
	mux.HandleFunc("GET /api/v1/ws", a.hub.Handle)

	// 同一个端口顺带托管前端静态文件，省掉一次反向代理
	if a.cfg.WebDir != "" {
		if st, err := os.Stat(a.cfg.WebDir); err == nil && st.IsDir() {
			mux.Handle("/", http.FileServer(http.Dir(a.cfg.WebDir)))
			log.Printf("静态前端已挂载: %s", a.cfg.WebDir)
		}
	}

	return a.withMiddleware(mux)
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	jsonHeader(w)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":     "ok",
		"mqtt":       a.mq.Connected(),
		"ws_clients": a.hub.Count(),
		"time_ms":    nowMs(),
	})
}

// ---------- 网关 ----------

func (a *API) listGateways(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	items, err := a.store.ListGateways(limit, offset)
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	total, err := a.store.CountGateways()
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	var next *string
	if offset+len(items) < total {
		c := encCursor(offset + len(items))
		next = &c
	}
	writeList(w, 200, items, next)
}

func (a *API) getGateway(w http.ResponseWriter, r *http.Request) {
	g, err := a.store.GetGateway(r.PathValue("gateway_id"))
	if errors.Is(err, errNotFound) {
		writeErr(w, 404, "NOT_FOUND", "网关不存在")
		return
	}
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	writeData(w, 200, g)
}

// ---------- 设备 ----------

func (a *API) listDevices(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	items, err := a.store.ListDevices(r.URL.Query().Get("gateway_id"), limit, offset)
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	var next *string
	if len(items) == limit {
		c := encCursor(offset + len(items))
		next = &c
	}
	writeList(w, 200, items, next)
}

func (a *API) getDevice(w http.ResponseWriter, r *http.Request) {
	d, err := a.store.GetDevice(r.PathValue("device_id"))
	if errors.Is(err, errNotFound) {
		writeErr(w, 404, "NOT_FOUND", "设备不存在")
		return
	}
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	writeData(w, 200, d)
}

// ---------- 命令 ----------

type createCommandReq struct {
	Endpoint string `json:"endpoint"`
	Action   string `json:"action"`
	Params   struct {
		Power *bool `json:"power"`
	} `json:"params"`
	TimeoutMs *int `json:"timeout_ms"`
}

func (a *API) createCommand(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")

	// 契约：鉴权后先检查幂等重放，再检查在线状态
	key := r.Header.Get("Idempotency-Key")
	if key == "" || len(key) > 128 {
		writeErr(w, 400, "INVALID_ARGUMENT", "缺少 Idempotency-Key")
		return
	}

	var req createCommandReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, 400, "INVALID_ARGUMENT", "请求体不是合法 JSON")
		return
	}
	if req.Endpoint == "" {
		writeErr(w, 400, "INVALID_ARGUMENT", "endpoint 不能为空")
		return
	}
	if req.Action != "set_power" {
		writeErr(w, 400, "INVALID_ARGUMENT", "v1 仅支持 action=set_power")
		return
	}
	if req.Params.Power == nil {
		writeErr(w, 400, "INVALID_ARGUMENT", "params.power 必填且为 boolean")
		return
	}
	timeout := 5000
	if req.TimeoutMs != nil {
		timeout = *req.TimeoutMs
		if timeout < 100 || timeout > 30000 {
			writeErr(w, 400, "INVALID_ARGUMENT", "timeout_ms 取值范围 100..30000")
			return
		}
	}

	scope := "dev:" + deviceID + "|key:" + key
	fingerprint := fmt.Sprintf("%s|%s|%t|%d", req.Endpoint, req.Action, *req.Params.Power, timeout)

	if fp, cmdID, ok, err := a.store.GetIdempotent(scope); err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	} else if ok {
		if fp != fingerprint {
			writeErr(w, 409, "IDEMPOTENCY_CONFLICT", "同一 Idempotency-Key 对应了不同请求")
			return
		}
		cmd, err := a.store.GetCommand(cmdID)
		if err == nil {
			writeData(w, 202, cmd)
			return
		}
	}

	dev, err := a.store.GetDevice(deviceID)
	if errors.Is(err, errNotFound) {
		writeErr(w, 404, "NOT_FOUND", "设备不存在")
		return
	}
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}

	// 契约：能力校验
	ep, okCap := dev.Capabilities[req.Endpoint]
	if !okCap || !contains(ep.Actions, req.Action) {
		writeErr(w, 422, "UNSUPPORTED_ACTION", "设备不支持该动作")
		return
	}

	// 契约：即时控制要求网关与设备同时在线
	gw, err := a.store.GetGateway(dev.GatewayID)
	if err != nil || gw == nil || !gw.Online {
		writeErr(w, 409, "GATEWAY_OFFLINE", "网关当前离线")
		return
	}
	if !dev.Online {
		writeErr(w, 409, "DEVICE_OFFLINE", "设备当前离线")
		return
	}

	t := nowMs()
	cmd := &Command{
		CommandID:       randID("cmd_"),
		GatewayID:       dev.GatewayID,
		DeviceID:        dev.DeviceID,
		Endpoint:        req.Endpoint,
		Action:          req.Action,
		Params:          CommandParams{Power: *req.Params.Power},
		Status:          "queued",
		IssuedAtMs:      t,
		ExpiresAtMs:     t + int64(timeout),
		UpdatedAtMs:     t,
		CommandRevision: 1,
	}
	if err := a.store.InsertCommand(cmd); err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	if err := a.store.PutIdempotent(scope, fingerprint, cmd.CommandID); err != nil {
		log.Printf("幂等键写入失败: %v", err)
	}

	gc := GatewayCommand{
		SchemaVersion: 1,
		CommandID:     cmd.CommandID,
		GatewayID:     cmd.GatewayID,
		DeviceID:      cmd.DeviceID,
		Endpoint:      cmd.Endpoint,
		Action:        cmd.Action,
		Params:        cmd.Params,
		IssuedAtMs:    cmd.IssuedAtMs,
		ExpiresAtMs:   cmd.ExpiresAtMs,
	}
	if err := a.mq.PublishCommand(gc); err != nil {
		log.Printf("命令 %s 下发失败: %v（保持 queued，等待过期）", cmd.CommandID, err)
	} else if next, changed, err := a.store.UpdateCommandStatus(cmd.CommandID, "dispatched", nil, nil, -1); err == nil && changed {
		cmd = next
		a.hub.Broadcast(cmd.GatewayID, Notification{SchemaVersion: 1, Type: "command.updated", Data: cmd})
	}

	writeData(w, 202, cmd)
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func (a *API) getCommand(w http.ResponseWriter, r *http.Request) {
	cmd, err := a.store.GetCommand(r.PathValue("command_id"))
	if errors.Is(err, errNotFound) {
		writeErr(w, 404, "NOT_FOUND", "命令不存在")
		return
	}
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}
	writeData(w, 200, cmd)
}

// ---------- 事件 ----------

func (a *API) listEvents(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")
	q := r.URL.Query()

	limit, _ := pageParams(r)

	var from, to *int64
	if v := q.Get("from_at_ms"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			from = &n
		}
	}
	if v := q.Get("to_at_ms"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			to = &n
		}
	}

	var beforeMs *int64
	beforeID := ""
	if c := q.Get("cursor"); c != "" {
		if ms, id, ok := decEventCursor(c); ok {
			beforeMs = &ms
			beforeID = id
		}
	}

	items, hasMore, err := a.store.ListEvents(deviceID, from, to, limit, beforeMs, beforeID)
	if err != nil {
		writeErr(w, 500, "INTERNAL_ERROR", err.Error())
		return
	}

	var next *string
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		c := encEventCursor(last.ReceivedAtMs, last.EventID)
		next = &c
	}
	writeList(w, 200, items, next)
}

// ---------- 后台任务 ----------

// StartSweeper 负责命令过期与幂等键清理。
func StartSweeper(store *Store, hub *Hub) {
	go func() {
		tick := time.NewTicker(1 * time.Second)
		defer tick.Stop()
		lastPurge := time.Now()
		for range tick.C {
			ids, err := store.ExpiredCommands(nowMs())
			if err == nil {
				for _, id := range ids {
					cmd, changed, err := store.UpdateCommandStatus(id, "expired", nil,
						&ErrorBody{Code: "COMMAND_EXPIRED", Message: "命令到期仍未收到设备确认"}, -1)
					if err == nil && changed && cmd != nil {
						hub.Broadcast(cmd.GatewayID, Notification{SchemaVersion: 1, Type: "command.updated", Data: cmd})
					}
				}
			}
			if time.Since(lastPurge) > time.Hour {
				lastPurge = time.Now()
				// 契约：幂等键至少保存 24 小时
				_ = store.PurgeIdempotency(nowMs() - 24*3600*1000)
			}
		}
	}()
}
