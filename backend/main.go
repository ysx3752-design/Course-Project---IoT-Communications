package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("[tinygate] ")

	cfg := loadConfig()

	store, err := OpenStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}
	if err := store.Migrate(); err != nil {
		log.Fatalf("初始化表结构失败: %v", err)
	}
	if err := store.Seed(); err != nil {
		log.Printf("预置设备目录失败: %v", err)
	}

	hub := NewHub(cfg.Token)
	mq := NewMQTT(cfg, store, hub)
	mq.Start()

	api := NewAPI(store, hub, mq, cfg)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		// 不设 WriteTimeout：WebSocket 需要长连接
	}

	StartSweeper(store, hub)

	go func() {
		log.Printf("HTTP 服务监听 %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP 服务异常: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Printf("服务已退出")
}
