package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr        string
	MySQLDSN    string
	MQTTBroker  string
	MQTTUser    string
	MQTTPass    string
	Token       string
	CORSOrigins string
	WebDir      string
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	return Config{
		Addr: env("TG_ADDR", ":8080"),
		MySQLDSN: env("TG_MYSQL_DSN",
			"tinygate:Tg2026_IoT!@tcp(127.0.0.1:3306)/tinygate?charset=utf8mb4&loc=UTC&timeout=5s"),
		MQTTBroker:  env("TG_MQTT_BROKER", "tcp://127.0.0.1:1883"),
		MQTTUser:    env("TG_MQTT_USER", "backend"),
		MQTTPass:    env("TG_MQTT_PASS", "backend_secret"),
		Token:       env("TG_TOKEN", "tinygate-demo-token"),
		CORSOrigins: env("TG_CORS", "*"),
		WebDir:      env("TG_WEB_DIR", "web"),
	}
}

func nowMs() int64 { return time.Now().UnixMilli() }

func msPtr(v int64) *int64 { return &v }

func msVal(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func randID(prefix string) string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return prefix + hex.EncodeToString([]byte(time.Now().Format("150405.000")))
	}
	return prefix + hex.EncodeToString(b)
}

// 契约：request_id 必填，1..128 字符
func newRequestID() string { return randID("req_") }

func allowOrigin(conf string, origin string) string {
	if conf == "*" {
		return "*"
	}
	for _, o := range strings.Split(conf, ",") {
		if strings.TrimSpace(o) == origin {
			return origin
		}
	}
	return ""
}

func jsonHeader(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
}
