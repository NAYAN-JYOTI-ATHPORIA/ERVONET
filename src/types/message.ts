export type MessagePriority = 'NORMAL' | 'URGENT' | 'CRITICAL_SOS';

export type MessageType =
  | 'TEXT'
  | 'ALERT'
  | 'ACK'
  | 'PING'
  | 'MAP_DATA'
  | 'ROUTING'
  | 'CHAT'
  | 'SOS'
  | 'LOCATION'
  | 'NODE_BEACON'
  | 'NODE_STATUS'
  | 'ROUTE_UPDATE'
  | 'MAP_SERVER_CMD';

export interface RelayNodeTelemetry {
  nodeId: string;
  name: string;
  bleClients: number;
  espNowPeers: number;
  queueSize: number;
  relayed: number;
  dropped: number;
  batteryPct: number;
  sdReady?: boolean;
  mapServer?: boolean;
  freeHeap: number;
  uptimeSec: number;
  lastUpdated: number;
}

export interface MapServerStatus {
  relayNodeId: string;
  active: boolean;
  ssid: string;
  password?: string;
  ip: string;
  channel: number;
  url: string;
  sizeBytes: number;
  sdReady: boolean;
  validPmTiles: boolean;
  expiresInSec: number;
  lastUpdated: number;
}

export interface MapSectorPayload {
  type: 'MAP_SECTOR';
  name: string;
  bounds: [number, number, number, number]; // [west, south, east, north]
  minZoom?: number;
  maxZoom?: number;
  style?: string;
  center?: [number, number];
  timestamp: number;
}

export interface NeighborLink {
  nodeId: string;
  name?: string;
  rssi: number;
}

export interface LsaPayload {
  type: 'LSA';
  originNodeId: string;
  originName?: string;
  sequenceNumber: number;
  neighbors: NeighborLink[];
  timestamp: number;
}

export type DeliveryStatus =
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'ACKNOWLEDGED'
  | 'FAILED';

export interface ResQNetPacket {
  messageId: string;
  senderId: string;
  senderName?: string; // Human-friendly chosen username e.g. "Nayan", "Alice"
  destinationId: string; // 'BROADCAST' or specific Node ID / Username
  timestamp: number;
  ttl: number; // Time-to-Live / Hop limit (default 10 for multi-hop mesh)
  priority: MessagePriority;
  messageType: MessageType;
  payload: string;
  hopCount: number;
  checksum: string;
  authTag?: string; // Optional HMAC-SHA256 tag (matched against ESP32 mbedTLS when enabled)
  encrypted?: boolean; // True when payload holds SHA256-CTR hex ciphertext
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  // Multi-Hop Routing Fields (Dijkstra / Managed Mesh)
  route?: string[]; // Deterministic path calculated by Dijkstra: ['ERVO-A', 'ERVO-B', 'ERVO-C', 'ERVO-D', 'ERVO-E', 'ERVO-F']
  routeIndex?: number; // Current pointer in route array
  routingAlgo?: 'DIJKSTRA' | 'FLOOD';
  visitedNodes?: string[]; // Traversed node IDs to prevent loops and reflection
  relayTrace?: string[]; // Human-readable trace of hops for UI display
}

export type ErvoNetPacket = ResQNetPacket;

export interface MessageRecord {
  id: string; // Internal record id (matches packet messageId)
  packet: ResQNetPacket;
  direction: 'INCOMING' | 'OUTGOING';
  status: DeliveryStatus;
  targetAddress?: string; // Target device Bluetooth address
  latencyMs?: number;
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  errorMessage?: string;
}

