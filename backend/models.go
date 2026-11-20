package main

// 与 contracts/schemas/messages.schema.json 一一对应的类型。
// 字段名、可空性、枚举值都必须与 schema 完全一致，改动前先改契约。

// ---------- 设备与网关快照 ----------

type PropertyCapability struct {
	Type     string `json:"type"`
	Readable bool   `json:"readable"`
	Writable bool   `json:"writable"`
	Unit     string `json:"unit,omitempty"`
}

type EndpointCapability struct {
	Properties map[string]PropertyCapability `json:"properties"`
	Actions    []string                      `json:"actions"`
}

type Device struct {
	DeviceID      string                        `json:"device_id"`
	GatewayID     string                        `json:"gateway_id"`
	Name          string                        `json:"name"`
	Protocol      string                        `json:"protocol"`
	Online        bool                          `json:"online"`
	LastSeenAtMs  *int64                        `json:"last_seen_at_ms"`
	Capabilities  map[string]EndpointCapability `json:"capabilities"`
	ReportedState map[string]map[string]any     `json:"reported_state"`
	StateRevision int64                         `json:"state_revision"`
}

type Gateway struct {
	GatewayID       string `json:"gateway_id"`
	Name            string `json:"name"`
	Online          bool   `json:"online"`
	LastSeenAtMs    *int64 `json:"last_seen_at_ms"`
	FirmwareVersion string `json:"firmware_version"`
	StateRevision   int64  `json:"state_revision"`
}

// ---------- 错误 ----------

type ErrorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// ---------- 命令 ----------

type CommandParams struct {
	Power bool `json:"power"`
}

type CommandState struct {
	Power bool `json:"power"`
}

type CommandRequest struct {
	Endpoint  string        `json:"endpoint"`
	Action    string        `json:"action"`
	Params    CommandParams `json:"params"`
	TimeoutMs *int          `json:"timeout_ms"`
}

type Command struct {
	CommandID       string        `json:"command_id"`
	GatewayID       string        `json:"gateway_id"`
	DeviceID        string        `json:"device_id"`
	Endpoint        string        `json:"endpoint"`
	Action          string        `json:"action"`
	Params          CommandParams `json:"params"`
	Status          string        `json:"status"`
	IssuedAtMs      int64         `json:"issued_at_ms"`
	ExpiresAtMs     int64         `json:"expires_at_ms"`
	UpdatedAtMs     int64         `json:"updated_at_ms"`
	CommandRevision int64         `json:"command_revision"`
	ReportedState   *CommandState `json:"reported_state"`
	Error           *ErrorBody    `json:"error"`
}

// GatewayCommand 是下发到网关的 MQTT 载荷。
type GatewayCommand struct {
	SchemaVersion int           `json:"schema_version"`
	CommandID     string        `json:"command_id"`
	GatewayID     string        `json:"gateway_id"`
	DeviceID      string        `json:"device_id"`
	Endpoint      string        `json:"endpoint"`
	Action        string        `json:"action"`
	Params        CommandParams `json:"params"`
	IssuedAtMs    int64         `json:"issued_at_ms"`
	ExpiresAtMs   int64         `json:"expires_at_ms"`
}

type CommandResult struct {
	SchemaVersion int           `json:"schema_version"`
	GatewayID     string        `json:"gateway_id"`
	CommandID     string        `json:"command_id"`
	DeviceID      string        `json:"device_id"`
	Endpoint      string        `json:"endpoint"`
	ResultSeq     int64         `json:"result_seq"`
	Status        string        `json:"status"`
	ReportedState *CommandState `json:"reported_state"`
	Error         *ErrorBody    `json:"error"`
}

// ---------- 事件与状态 ----------

type Event struct {
	SchemaVersion int            `json:"schema_version"`
	EventID       string         `json:"event_id"`
	GatewayID     string         `json:"gateway_id"`
	DeviceID      string         `json:"device_id"`
	BootID        string         `json:"boot_id"`
	BootCounter   int64          `json:"boot_counter"`
	Seq           int64          `json:"seq"`
	Type          string         `json:"type"`
	OccurredAtMs  *int64         `json:"occurred_at_ms"`
	UptimeMs      int64          `json:"uptime_ms"`
	Replayed      bool           `json:"replayed"`
	Data          map[string]any `json:"data"`
	ReceivedAtMs  int64          `json:"received_at_ms,omitempty"`
}

type GatewayStatus struct {
	SchemaVersion   int    `json:"schema_version"`
	GatewayID       string `json:"gateway_id"`
	BootID          string `json:"boot_id"`
	BootCounter     int64  `json:"boot_counter"`
	ConnectionID    string `json:"connection_id"`
	ConnectionSeq   int64  `json:"connection_seq"`
	Online          bool   `json:"online"`
	ReportedAtMs    *int64 `json:"reported_at_ms"`
	FirmwareVersion string `json:"firmware_version"`
}

// ---------- 实时通知 ----------

type Notification struct {
	SchemaVersion int    `json:"schema_version"`
	Type          string `json:"type"`
	Data          any    `json:"data"`
}

type ClientFrame struct {
	Type        string   `json:"type"`
	AccessToken string   `json:"access_token"`
	GatewayIDs  []string `json:"gateway_ids"`
}

type ServerFrame struct {
	Type          string   `json:"type"`
	SchemaVersion int      `json:"schema_version,omitempty"`
	GatewayIDs    []string `json:"gateway_ids,omitempty"`
	Code          string   `json:"code,omitempty"`
}
