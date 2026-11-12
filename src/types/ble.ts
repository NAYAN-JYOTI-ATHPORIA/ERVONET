export type NodeRole =
  | 'Field Worker'
  | 'Digester Safety Unit'
  | 'Relay Node'
  | 'Emergency Coordinator';

export type ConnectionStatus =
  | 'DISCOVERED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED';

export interface PeerNode {
  id: string; // MAC address or unique device ID
  name: string;
  nodeId: string; // ResQNet node identifier (e.g. RESQ-NODE-02)
  role: NodeRole;
  rssi: number; // Signal strength in dBm (-95 to -30)
  distanceMeters: number; // Estimated distance based on log-distance path loss
  connectionState: ConnectionStatus;
  lastSeen: number; // Epoch timestamp ms
  batteryLevel?: number; // Estimated or reported battery %
  packetsReceived: number;
  packetsSent: number;
  isRelayCapable?: boolean;
  lastKnownLocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    timestamp?: number;
  };
  hasActiveSos?: boolean;
  // Multi-Hop Routing Properties
  isMultiHop?: boolean;
  hopCount?: number;
  viaNodeId?: string; // The 1-hop neighbor node ID used to relay to this node
  relayPath?: string[]; // Full Dijkstra path (e.g. ['ERVO-A', 'ERVO-B', 'ERVO-C', 'ERVO-D', 'ERVO-E', 'ERVO-F'])
}

export interface RadioState {
  isSupported: boolean;
  isEnabled: boolean;
  isAdvertising: boolean;
  isScanning: boolean;
  autoConnect: boolean;
  scanIntervalMs: number;
  connectedCount: number;
  discoveredCount: number;
  operatingMode: 'NATIVE_BLE' | 'SIMULATION_TESTBED';
}

