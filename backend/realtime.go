package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Hub 实现 contracts/realtime.md：
// 连接后 5 秒内必须 authenticate，未鉴权不发送业务数据；
// subscribe 校验后替换原订阅，上限 100 个网关；应用层 ping/pong。
type Hub struct {
	mu      sync.RWMutex
	clients map[*wsClient]struct{}
	token   string
}

type wsClient struct {
	conn   *websocket.Conn
	send   chan []byte
	mu     sync.Mutex
	subs   map[string]bool
	authed bool
}

const maxGatewaysPerSub = 100

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func NewHub(token string) *Hub {
	return &Hub{clients: map[*wsClient]struct{}{}, token: token}
}

func (h *Hub) Handle(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	c := &wsClient{conn: conn, send: make(chan []byte, 64), subs: map[string]bool{}}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	go c.writeLoop()

	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		close(c.send)
		conn.Close()
	}()

	// 契约：建立连接后 5 秒内发送 authenticate
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var f ClientFrame
		if err := json.Unmarshal(data, &f); err != nil {
			c.sendJSON(ServerFrame{Type: "error", Code: "INVALID_ARGUMENT"})
			continue
		}

		switch f.Type {
		case "authenticate":
			if h.token != "" && f.AccessToken != h.token {
				conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(1008, "unauthorized"), time.Now().Add(time.Second))
				return
			}
			c.mu.Lock()
			c.authed = true
			c.mu.Unlock()
			_ = conn.SetReadDeadline(time.Time{})
			c.sendJSON(ServerFrame{Type: "authenticated", SchemaVersion: 1})

		case "subscribe":
			if !c.isAuthed() {
				conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(1008, "not authenticated"), time.Now().Add(time.Second))
				return
			}
			if len(f.GatewayIDs) > maxGatewaysPerSub {
				c.sendJSON(ServerFrame{Type: "error", Code: "INVALID_ARGUMENT"})
				continue
			}
			next := map[string]bool{}
			for _, id := range f.GatewayIDs {
				next[id] = true
			}
			c.mu.Lock()
			c.subs = next // 契约：每次 subscribe 替换原订阅
			c.mu.Unlock()
			c.sendJSON(ServerFrame{Type: "subscribed", GatewayIDs: f.GatewayIDs})

		case "ping":
			c.sendJSON(ServerFrame{Type: "pong"})

		default:
			c.sendJSON(ServerFrame{Type: "error", Code: "INVALID_ARGUMENT"})
		}
	}
}

func (c *wsClient) isAuthed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.authed
}

func (c *wsClient) subscribed(gatewayID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.authed && c.subs[gatewayID]
}

func (c *wsClient) sendJSON(v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.send <- raw:
	default:
		// 慢客户端丢弃，避免阻塞广播
	}
}

func (c *wsClient) writeLoop() {
	for msg := range c.send {
		_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// Broadcast 只推给已鉴权且订阅了该网关的连接。
func (h *Hub) Broadcast(gatewayID string, n Notification) {
	h.mu.RLock()
	targets := make([]*wsClient, 0, len(h.clients))
	for c := range h.clients {
		if c.subscribed(gatewayID) {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.sendJSON(n)
	}
}

func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
