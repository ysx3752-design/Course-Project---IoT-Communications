package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// 契约见 contracts/mqtt.md：
// 前缀 tinygate/v1/gateways/{gateway_id}，四个后缀，QoS 1。
const (
	topicRoot      = "tinygate/v1/gateways"
	suffixEvents   = "events"
	suffixStatus   = "status"
	suffixCommands = "commands"
	suffixResults  = "command_results"
	maxPayloadSize = 8192 // 契约建议单条 JSON 上限
)

type MQTT struct {
	cfg   Config
	store *Store
	hub   *Hub
	cli   mqtt.Client
}

func NewMQTT(cfg Config, store *Store, hub *Hub) *MQTT {
	return &MQTT{cfg: cfg, store: store, hub: hub}
}

func (m *MQTT) Start() {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(m.cfg.MQTTBroker)
	// 固定 clientID + CleanSession=false：后端重启期间 broker 仍为其排队消息，
	// 兑现 contracts/mqtt.md 中「后端使用持久订阅」的承诺。重复投递由 event_id / result_seq 去重。
	opts.SetClientID("tinygate-backend")
	opts.SetCleanSession(false)
	opts.SetResumeSubs(true)
	opts.SetUsername(m.cfg.MQTTUser)
	opts.SetPassword(m.cfg.MQTTPass)
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(5 * time.Second)
	opts.SetMaxReconnectInterval(30 * time.Second)
	opts.SetKeepAlive(30 * time.Second)

	opts.SetOnConnectHandler(func(c mqtt.Client) {
		log.Printf("mqtt 已连接 %s", m.cfg.MQTTBroker)
		topics := map[string]byte{
			topicRoot + "/+/" + suffixEvents:  1,
			topicRoot + "/+/" + suffixStatus:  1,
			topicRoot + "/+/" + suffixResults: 1,
		}
		tok := c.SubscribeMultiple(topics, m.onMessage)
		go func() {
			tok.WaitTimeout(10 * time.Second)
			if err := tok.Error(); err != nil {
				log.Printf("mqtt 订阅失败: %v", err)
			} else {
				log.Printf("mqtt 订阅完成：events / status / command_results")
			}
		}()
	})

	opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
		log.Printf("mqtt 连接断开: %v（自动重连中）", err)
	})

	m.cli = mqtt.NewClient(opts)
	tok := m.cli.Connect()
	if !tok.WaitTimeout(8 * time.Second) {
		log.Printf("mqtt 首次连接超时，后台继续重试")
		return
	}
	if err := tok.Error(); err != nil {
		log.Printf("mqtt 首次连接失败: %v（后台继续重试）", err)
	}
}

func (m *MQTT) Connected() bool {
	return m.cli != nil && m.cli.IsConnected()
}

func (m *MQTT) onMessage(_ mqtt.Client, msg mqtt.Message) {
	if len(msg.Payload()) > maxPayloadSize {
		log.Printf("丢弃超长报文 topic=%s size=%d", msg.Topic(), len(msg.Payload()))
		return
	}

	parts := strings.Split(msg.Topic(), "/")
	if len(parts) != 5 || parts[0] != "tinygate" {
		return
	}
	gwID := parts[3]
	suffix := parts[4]

	switch suffix {
	case suffixEvents:
		m.handleEvent(gwID, msg.Payload())
	case suffixStatus:
		m.handleStatus(gwID, msg.Payload())
	case suffixResults:
		m.handleResult(gwID, msg.Payload())
	}
}

func (m *MQTT) handleEvent(gwID string, payload []byte) {
	var ev Event
	if err := json.Unmarshal(payload, &ev); err != nil {
		log.Printf("events 解析失败: %v", err)
		return
	}
	// 契约：不能信任 JSON 中自报的归属，必须与 Topic 一致
	if ev.GatewayID != gwID {
		log.Printf("events 归属不一致 topic=%s payload=%s", gwID, ev.GatewayID)
		return
	}
	if ev.SchemaVersion != 1 {
		log.Printf("events 版本不支持: %d", ev.SchemaVersion)
		return
	}
	ev.ReceivedAtMs = nowMs() // 契约：后端另记 received_at_ms，不冒充采集时间

	dev, err := m.store.ApplyEvent(&ev)
	if err != nil {
		log.Printf("events 入库失败: %v", err)
		return
	}
	if dev != nil {
		m.hub.Broadcast(gwID, Notification{SchemaVersion: 1, Type: "device.state_changed", Data: dev})
	}
}

func (m *MQTT) handleStatus(gwID string, payload []byte) {
	var st GatewayStatus
	if err := json.Unmarshal(payload, &st); err != nil {
		log.Printf("status 解析失败: %v", err)
		return
	}
	if st.GatewayID != gwID {
		log.Printf("status 归属不一致 topic=%s payload=%s", gwID, st.GatewayID)
		return
	}
	gw, changed, err := m.store.TouchGatewayStatus(st)
	if err != nil {
		log.Printf("status 处理失败: %v", err)
		return
	}
	if changed && gw != nil {
		m.hub.Broadcast(gwID, Notification{SchemaVersion: 1, Type: "gateway.status_changed", Data: gw})
	}
}

func (m *MQTT) handleResult(gwID string, payload []byte) {
	var res CommandResult
	if err := json.Unmarshal(payload, &res); err != nil {
		log.Printf("command_results 解析失败: %v", err)
		return
	}
	if res.GatewayID != gwID {
		log.Printf("command_results 归属不一致 topic=%s payload=%s", gwID, res.GatewayID)
		return
	}
	cmd, changed, err := m.store.UpdateCommandStatus(res.CommandID, res.Status, res.ReportedState, res.Error, res.ResultSeq)
	if err != nil {
		log.Printf("command_results 处理失败: %v", err)
		return
	}
	if changed && cmd != nil {
		m.hub.Broadcast(gwID, Notification{SchemaVersion: 1, Type: "command.updated", Data: cmd})
	}
}

// PublishCommand 下发 GatewayCommand，不使用 retained。
func (m *MQTT) PublishCommand(gc GatewayCommand) error {
	if !m.Connected() {
		return errors.New("mqtt not connected")
	}
	raw, err := json.Marshal(gc)
	if err != nil {
		return err
	}
	topic := fmt.Sprintf("%s/%s/%s", topicRoot, gc.GatewayID, suffixCommands)
	tok := m.cli.Publish(topic, 1, false, raw)
	if !tok.WaitTimeout(3 * time.Second) {
		return errors.New("publish timeout")
	}
	return tok.Error()
}
