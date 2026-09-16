export type MessagePriority = 'NORMAL' | 'URGENT' | 'CRITICAL_SOS';

export type MessageType = 'TEXT' | 'ALERT' | 'ACK' | 'PING';

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
  ttl: number; // Time-to-Live / Hop limit
  priority: MessagePriority;
  messageType: MessageType;
  payload: string;
  hopCount: number;
  checksum: string;
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

