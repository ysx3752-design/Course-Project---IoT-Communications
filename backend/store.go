package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var errNotFound = errors.New("not found")

type Store struct {
	db *sql.DB
}

func OpenStore(dsn string) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

const schemaSQL = `
CREATE TABLE IF NOT EXISTS gateways (
  gateway_id        VARCHAR(128) PRIMARY KEY,
  name              VARCHAR(191) NOT NULL DEFAULT '',
  online            TINYINT(1)   NOT NULL DEFAULT 0,
  last_seen_at_ms   BIGINT       NULL,
  firmware_version  VARCHAR(64)  NOT NULL DEFAULT '',
  state_revision    BIGINT       NOT NULL DEFAULT 0,
  boot_counter      BIGINT       NOT NULL DEFAULT -1,
  connection_seq    BIGINT       NOT NULL DEFAULT -1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS devices (
  device_id         VARCHAR(128) PRIMARY KEY,
  gateway_id        VARCHAR(128) NOT NULL,
  name              VARCHAR(191) NOT NULL,
  protocol          VARCHAR(16)  NOT NULL,
  online            TINYINT(1)   NOT NULL DEFAULT 0,
  last_seen_at_ms   BIGINT       NULL,
  capabilities      JSON         NOT NULL,
  reported_state    JSON         NOT NULL,
  state_revision    BIGINT       NOT NULL DEFAULT 0,
  last_boot_counter BIGINT       NOT NULL DEFAULT -1,
  last_seq          BIGINT       NOT NULL DEFAULT -1,
  KEY idx_gw (gateway_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS events (
  event_id        VARCHAR(128) PRIMARY KEY,
  gateway_id      VARCHAR(128) NOT NULL,
  device_id       VARCHAR(128) NOT NULL,
  boot_id         VARCHAR(128) NOT NULL,
  boot_counter    BIGINT       NOT NULL,
  seq             BIGINT       NOT NULL,
  type            VARCHAR(32)  NOT NULL,
  occurred_at_ms  BIGINT       NULL,
  uptime_ms       BIGINT       NOT NULL,
  replayed        TINYINT(1)   NOT NULL,
  data            JSON         NOT NULL,
  received_at_ms  BIGINT       NOT NULL,
  KEY idx_dev_time (device_id, received_at_ms, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS commands (
  command_id        VARCHAR(128) PRIMARY KEY,
  gateway_id        VARCHAR(128) NOT NULL,
  device_id         VARCHAR(128) NOT NULL,
  endpoint          VARCHAR(128) NOT NULL,
  action            VARCHAR(64)  NOT NULL,
  params            JSON         NOT NULL,
  status            VARCHAR(16)  NOT NULL,
  issued_at_ms      BIGINT       NOT NULL,
  expires_at_ms     BIGINT       NOT NULL,
  updated_at_ms     BIGINT       NOT NULL,
  command_revision  BIGINT       NOT NULL DEFAULT 1,
  reported_state    JSON         NULL,
  error_code        VARCHAR(64)  NULL,
  error_message     VARCHAR(255) NULL,
  last_result_seq   BIGINT       NOT NULL DEFAULT -1,
  KEY idx_status_exp (status, expires_at_ms),
  KEY idx_dev (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS idempotency (
  scope         VARCHAR(320) PRIMARY KEY,
  fingerprint   VARCHAR(512) NOT NULL,
  command_id    VARCHAR(128) NOT NULL,
  created_at_ms BIGINT       NOT NULL,
  KEY idx_created (created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

func (s *Store) Migrate() error {
	for _, stmt := range splitStatements(schemaSQL) {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}

func splitStatements(sqlText string) []string {
	var out []string
	var b strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		b.WriteString(line)
		b.WriteString("\n")
		if strings.HasSuffix(strings.TrimSpace(line), ";") {
			if s := strings.TrimSpace(b.String()); s != "" {
				out = append(out, s)
			}
			b.Reset()
		}
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		out = append(out, s)
	}
	return out
}

// Seed 预置与契约 device-models.md 一致的设备目录，便于首次联调。
func (s *Store) Seed() error {
	ctl := `{"1":{"properties":{"power":{"type":"boolean","readable":true,"writable":true}},"actions":["set_power"]}}`
	sensor := `{"10":{"properties":{"temperature":{"type":"number","readable":true,"writable":false,"unit":"degC"}},"actions":[]}}`

	gateways := []struct{ id, name string }{
		{"gw_01", "网关一号"},
		{"gw_02", "网关二号"},
	}
	for _, g := range gateways {
		if _, err := s.db.Exec(
			"INSERT IGNORE INTO gateways (gateway_id,name,firmware_version) VALUES (?,?,'0.1.0')",
			g.id, g.name); err != nil {
			return err
		}
	}

	devices := []struct{ id, gw, name, proto, cap, state string }{
		{"actuator_01", "gw_01", "模拟灯一", "ble", ctl, `{"1":{"power":false}}`},
		{"actuator_02", "gw_01", "模拟灯二", "ble", ctl, `{"1":{"power":false}}`},
		{"actuator_03", "gw_01", "模拟灯三", "ble", ctl, `{"1":{"power":false}}`},
		{"sensor_01", "gw_01", "温度传感器一", "zigbee", sensor, `{"10":{"temperature":0}}`},
		{"sensor_02", "gw_02", "温度传感器二", "zigbee", sensor, `{"10":{"temperature":0}}`},
	}
	for _, d := range devices {
		if _, err := s.db.Exec(
			"INSERT IGNORE INTO devices (device_id,gateway_id,name,protocol,capabilities,reported_state) VALUES (?,?,?,?,?,?)",
			d.id, d.gw, d.name, d.proto, d.cap, d.state); err != nil {
			return err
		}
	}
	return nil
}

// ---------------- 网关 ----------------

func (s *Store) ListGateways(limit, offset int) ([]Gateway, error) {
	rows, err := s.db.Query(
		`SELECT gateway_id,name,online,last_seen_at_ms,firmware_version,state_revision
		 FROM gateways ORDER BY gateway_id LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Gateway{}
	for rows.Next() {
		var g Gateway
		var seen sql.NullInt64
		if err := rows.Scan(&g.GatewayID, &g.Name, &g.Online, &seen, &g.FirmwareVersion, &g.StateRevision); err != nil {
			return nil, err
		}
		if seen.Valid {
			g.LastSeenAtMs = &seen.Int64
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) CountGateways() (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM gateways").Scan(&n)
	return n, err
}

func (s *Store) GetGateway(id string) (*Gateway, error) {
	var g Gateway
	var seen sql.NullInt64
	err := s.db.QueryRow(
		`SELECT gateway_id,name,online,last_seen_at_ms,firmware_version,state_revision
		 FROM gateways WHERE gateway_id=?`, id).
		Scan(&g.GatewayID, &g.Name, &g.Online, &seen, &g.FirmwareVersion, &g.StateRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if seen.Valid {
		g.LastSeenAtMs = &seen.Int64
	}
	return &g, nil
}

// TouchGatewayStatus 处理 status/LWT。
// 契约：用 (boot_counter, connection_seq) 比较连接新旧，旧连接的 LWT 不得覆盖新连接。
func (s *Store) TouchGatewayStatus(st GatewayStatus) (*Gateway, bool, error) {
	var curBoot, curConn int64
	err := s.db.QueryRow("SELECT boot_counter,connection_seq FROM gateways WHERE gateway_id=?",
		st.GatewayID).Scan(&curBoot, &curConn)
	if errors.Is(err, sql.ErrNoRows) {
		// 未登记网关：按契约不自动授予控制权限，只记录
		if _, e := s.db.Exec(
			`INSERT INTO gateways (gateway_id,name,online,last_seen_at_ms,firmware_version,state_revision,boot_counter,connection_seq)
			 VALUES (?,?,?,?,?,1,?,?)`,
			st.GatewayID, st.GatewayID, st.Online, nowMs(), st.FirmwareVersion, st.BootCounter, st.ConnectionSeq); e != nil {
			return nil, false, e
		}
		g, e := s.GetGateway(st.GatewayID)
		return g, true, e
	}
	if err != nil {
		return nil, false, err
	}

	stale := st.BootCounter < curBoot || (st.BootCounter == curBoot && st.ConnectionSeq < curConn)
	if stale {
		g, e := s.GetGateway(st.GatewayID)
		return g, false, e
	}

	seen := nowMs()
	if _, err := s.db.Exec(
		`UPDATE gateways SET online=?, last_seen_at_ms=?, firmware_version=?,
		 state_revision=state_revision+1, boot_counter=?, connection_seq=?
		 WHERE gateway_id=?`,
		st.Online, seen, st.FirmwareVersion, st.BootCounter, st.ConnectionSeq, st.GatewayID); err != nil {
		return nil, false, err
	}
	g, err := s.GetGateway(st.GatewayID)
	return g, true, err
}

// ---------------- 设备 ----------------

func scanDevice(rows interface {
	Scan(dest ...any) error
}) (*Device, error) {
	var d Device
	var seen sql.NullInt64
	var capRaw, stateRaw []byte
	if err := rows.Scan(&d.DeviceID, &d.GatewayID, &d.Name, &d.Protocol, &d.Online, &seen,
		&capRaw, &stateRaw, &d.StateRevision); err != nil {
		return nil, err
	}
	if seen.Valid {
		d.LastSeenAtMs = &seen.Int64
	}
	d.Capabilities = map[string]EndpointCapability{}
	d.ReportedState = map[string]map[string]any{}
	_ = json.Unmarshal(capRaw, &d.Capabilities)
	_ = json.Unmarshal(stateRaw, &d.ReportedState)
	if d.Capabilities == nil {
		d.Capabilities = map[string]EndpointCapability{}
	}
	if d.ReportedState == nil {
		d.ReportedState = map[string]map[string]any{}
	}
	return &d, nil
}

const deviceCols = `device_id,gateway_id,name,protocol,online,last_seen_at_ms,capabilities,reported_state,state_revision`

func (s *Store) ListDevices(gatewayID string, limit, offset int) ([]Device, error) {
	q := `SELECT ` + deviceCols + ` FROM devices`
	args := []any{}
	if gatewayID != "" {
		q += " WHERE gateway_id=?"
		args = append(args, gatewayID)
	}
	q += " ORDER BY device_id LIMIT ? OFFSET ?"
	args = append(args, limit, offset)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func (s *Store) GetDevice(id string) (*Device, error) {
	row := s.db.QueryRow(`SELECT `+deviceCols+` FROM devices WHERE device_id=?`, id)
	d, err := scanDevice(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return d, err
}

// ---------------- 事件 ----------------

// ApplyEvent 入库并按顺序更新设备状态。
// 返回发生变化的设备快照（用于推送 device.state_changed），无需推送时返回 nil。
func (s *Store) ApplyEvent(ev *Event) (*Device, error) {
	dataRaw, _ := json.Marshal(ev.Data)

	res, err := s.db.Exec(
		`INSERT IGNORE INTO events
		 (event_id,gateway_id,device_id,boot_id,boot_counter,seq,type,occurred_at_ms,uptime_ms,replayed,data,received_at_ms)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		ev.EventID, ev.GatewayID, ev.DeviceID, ev.BootID, ev.BootCounter, ev.Seq, ev.Type,
		nullInt(ev.OccurredAtMs), ev.UptimeMs, ev.Replayed, string(dataRaw), ev.ReceivedAtMs)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 契约：event_id 唯一入库；重复到达直接忽略
		return nil, nil
	}

	// 契约：replayed=true 的历史不覆盖新状态、不延长在线、不触发实时自动化
	if ev.Replayed {
		return nil, nil
	}

	dev, err := s.GetDevice(ev.DeviceID)
	if err != nil {
		return nil, nil // 未登记设备：只存事件，不产生控制权限
	}

	switch ev.Type {
	case "property_reported":
		ep, _ := ev.Data["endpoint"].(string)
		prop, _ := ev.Data["property"].(string)
		val, ok := ev.Data["value"]
		if ep == "" || prop == "" || !ok {
			return nil, nil
		}
		state := dev.ReportedState
		if state[ep] == nil {
			state[ep] = map[string]any{}
		}
		state[ep][prop] = val
		stateRaw, _ := json.Marshal(state)

		// 契约：按 (boot_counter, seq) 排序，旧顺序不能覆盖当前状态
		res, err := s.db.Exec(
			`UPDATE devices SET reported_state=?, last_seen_at_ms=?, state_revision=state_revision+1,
			 last_boot_counter=?, last_seq=?
			 WHERE device_id=? AND (last_boot_counter < ? OR (last_boot_counter=? AND last_seq < ?))`,
			string(stateRaw), ev.ReceivedAtMs, ev.BootCounter, ev.Seq, ev.DeviceID,
			ev.BootCounter, ev.BootCounter, ev.Seq)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil // 乱序旧事件：已入库但不更新状态
		}

	case "device_presence":
		online, _ := ev.Data["online"].(bool)
		if _, err := s.db.Exec(
			`UPDATE devices SET online=?, last_seen_at_ms=?, state_revision=state_revision+1
			 WHERE device_id=?`, online, ev.ReceivedAtMs, ev.DeviceID); err != nil {
			return nil, err
		}
	default:
		return nil, nil // alarm 只入库，不改状态
	}

	return s.GetDevice(ev.DeviceID)
}

func nullInt(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

// ListEvents 按 received_at_ms 倒序，keyset 分页保证稳定。
func (s *Store) ListEvents(deviceID string, from, to *int64, limit int, beforeMs *int64, beforeID string) ([]Event, bool, error) {
	q := `SELECT event_id,gateway_id,device_id,boot_id,boot_counter,seq,type,occurred_at_ms,uptime_ms,replayed,data,received_at_ms
	      FROM events WHERE device_id=?`
	args := []any{deviceID}

	if from != nil {
		q += " AND received_at_ms >= ?"
		args = append(args, *from)
	}
	if to != nil {
		q += " AND received_at_ms < ?"
		args = append(args, *to)
	}
	if beforeMs != nil {
		q += " AND (received_at_ms < ? OR (received_at_ms = ? AND event_id < ?))"
		args = append(args, *beforeMs, *beforeMs, beforeID)
	}
	q += " ORDER BY received_at_ms DESC, event_id DESC LIMIT ?"
	args = append(args, limit+1)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	out := []Event{}
	for rows.Next() {
		var e Event
		var occ sql.NullInt64
		var dataRaw []byte
		if err := rows.Scan(&e.EventID, &e.GatewayID, &e.DeviceID, &e.BootID, &e.BootCounter, &e.Seq,
			&e.Type, &occ, &e.UptimeMs, &e.Replayed, &dataRaw, &e.ReceivedAtMs); err != nil {
			return nil, false, err
		}
		if occ.Valid {
			e.OccurredAtMs = &occ.Int64
		}
		e.Data = map[string]any{}
		_ = json.Unmarshal(dataRaw, &e.Data)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return out, hasMore, nil
}

// ---------------- 命令 ----------------

const commandCols = `command_id,gateway_id,device_id,endpoint,action,params,status,
 issued_at_ms,expires_at_ms,updated_at_ms,command_revision,reported_state,error_code,error_message,last_result_seq`

func scanCommand(row interface{ Scan(dest ...any) error }) (*Command, int64, error) {
	var c Command
	var paramsRaw []byte
	var repRaw sql.NullString
	var errCode, errMsg sql.NullString
	var lastSeq int64

	err := row.Scan(&c.CommandID, &c.GatewayID, &c.DeviceID, &c.Endpoint, &c.Action, &paramsRaw,
		&c.Status, &c.IssuedAtMs, &c.ExpiresAtMs, &c.UpdatedAtMs, &c.CommandRevision,
		&repRaw, &errCode, &errMsg, &lastSeq)
	if err != nil {
		return nil, 0, err
	}

	_ = json.Unmarshal(paramsRaw, &c.Params)
	if repRaw.Valid && repRaw.String != "" {
		var st CommandState
		if json.Unmarshal([]byte(repRaw.String), &st) == nil {
			c.ReportedState = &st
		}
	}
	if errCode.Valid && errCode.String != "" {
		c.Error = &ErrorBody{Code: errCode.String, Message: errMsg.String}
	}
	return &c, lastSeq, nil
}

func (s *Store) InsertCommand(c *Command) error {
	paramsRaw, _ := json.Marshal(c.Params)
	_, err := s.db.Exec(
		`INSERT INTO commands (command_id,gateway_id,device_id,endpoint,action,params,status,
		 issued_at_ms,expires_at_ms,updated_at_ms,command_revision,reported_state,last_result_seq)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,-1)`,
		c.CommandID, c.GatewayID, c.DeviceID, c.Endpoint, c.Action, string(paramsRaw), c.Status,
		c.IssuedAtMs, c.ExpiresAtMs, c.UpdatedAtMs, c.CommandRevision)
	return err
}

func (s *Store) GetCommand(id string) (*Command, error) {
	row := s.db.QueryRow(`SELECT `+commandCols+` FROM commands WHERE command_id=?`, id)
	c, _, err := scanCommand(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return c, err
}

// UpdateCommandStatus 幂等地推进命令状态。
// 契约：终态不可变、禁止倒退、result_seq 必须递增。
func (s *Store) UpdateCommandStatus(cmdID, status string, rep *CommandState, eb *ErrorBody, resultSeq int64) (*Command, bool, error) {
	cur, lastSeq, err := func() (*Command, int64, error) {
		row := s.db.QueryRow(`SELECT `+commandCols+` FROM commands WHERE command_id=?`, cmdID)
		return scanCommand(row)
	}()
	if err != nil {
		return nil, false, err
	}

	if isTerminal(cur.Status) {
		return cur, false, nil
	}
	if resultSeq >= 0 && resultSeq <= lastSeq {
		return cur, false, nil
	}
	if rank(status) < rank(cur.Status) {
		return cur, false, nil
	}

	sets := "status=?, updated_at_ms=?, command_revision=command_revision+1"
	args := []any{status, nowMs()}
	if rep != nil {
		raw, _ := json.Marshal(rep)
		sets += ", reported_state=?"
		args = append(args, string(raw))
	}
	if eb != nil {
		sets += ", error_code=?, error_message=?"
		args = append(args, eb.Code, eb.Message)
	}
	if resultSeq >= 0 {
		sets += ", last_result_seq=?"
		args = append(args, resultSeq)
	}
	args = append(args, cmdID)

	if _, err := s.db.Exec("UPDATE commands SET "+sets+" WHERE command_id=?", args...); err != nil {
		return nil, false, err
	}
	next, err := s.GetCommand(cmdID)
	return next, true, err
}

func (s *Store) ExpiredCommands(now int64) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT command_id FROM commands
		 WHERE status IN ('queued','dispatched','accepted') AND expires_at_ms <= ? LIMIT 200`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func isTerminal(s string) bool {
	return s == "succeeded" || s == "failed" || s == "expired"
}

func rank(s string) int {
	switch s {
	case "queued":
		return 1
	case "dispatched":
		return 2
	case "accepted":
		return 3
	case "succeeded":
		return 4
	case "failed", "expired":
		return 5
	}
	return 0
}

// ---------------- 幂等 ----------------

func (s *Store) GetIdempotent(scope string) (string, string, bool, error) {
	var fp, cmdID string
	err := s.db.QueryRow("SELECT fingerprint,command_id FROM idempotency WHERE scope=?", scope).Scan(&fp, &cmdID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return fp, cmdID, true, nil
}

func (s *Store) PutIdempotent(scope, fp, cmdID string) error {
	_, err := s.db.Exec(
		`INSERT INTO idempotency (scope,fingerprint,command_id,created_at_ms) VALUES (?,?,?,?)
		 ON DUPLICATE KEY UPDATE fingerprint=fingerprint`,
		scope, fp, cmdID, nowMs())
	return err
}

func (s *Store) PurgeIdempotency(before int64) error {
	_, err := s.db.Exec("DELETE FROM idempotency WHERE created_at_ms < ?", before)
	return err
}
