import { MessageRecord } from '../types/message';
import { PeerNode, NodeRole } from '../types/ble';
import { NetworkMetrics } from '../types/metrics';

export interface LocalNodeConfig {
  nodeId: string;
  deviceId?: string;
  name: string;
  displayName: string;
  role: NodeRole;
  batteryLevel: number;
  hasConfiguredUsername: boolean;
}

class StorageService {
  private messages: MessageRecord[] = [];
  private peers: Map<string, PeerNode> = new Map();
  private localConfig: LocalNodeConfig;

  private metrics: NetworkMetrics = {
    totalSent: 0,
    totalReceived: 0,
    totalDelivered: 0,
    totalAcknowledged: 0,
    totalFailed: 0,
    totalRelayed: 0,
    duplicatesDropped: 0,
    expiredTtlDropped: 0,
    avgLatencyMs: 0,
    packetDeliveryRatio: 100,
    discoverySuccessRate: 100,
    activeLinksCount: 0,
    lastUpdated: Date.now(),
  };

  constructor() {
    this.localConfig = {
      nodeId: 'ERVO-LOCAL',
      name: '',
      displayName: '',
      role: 'Field Worker',
      batteryLevel: 98,
      hasConfiguredUsername: false,
    };
    this.messages = [];
  }

  public getLocalConfig(): LocalNodeConfig {
    return { ...this.localConfig };
  }

  public setFixedDeviceId(fixedId: string) {
    this.localConfig.deviceId = fixedId;
    this.localConfig.nodeId = fixedId;
    if (!this.localConfig.hasConfiguredUsername) {
      if (!this.localConfig.displayName || this.localConfig.displayName.startsWith('User-')) {
        this.localConfig.displayName = `User (${fixedId.replace('ERVO-', '').replace('RESQ-', '')})`;
        this.localConfig.name = this.localConfig.displayName;
      }
    }
  }

  public setSavedUsername(username: string) {
    const clean = username.trim();
    if (clean.length > 0) {
      this.localConfig.displayName = clean;
      this.localConfig.name = clean;
      this.localConfig.hasConfiguredUsername = true;
    }
  }

  public updateLocalConfig(config: Partial<LocalNodeConfig>) {
    this.localConfig = { ...this.localConfig, ...config };
  }

  public getMessages(): MessageRecord[] {
    return [...this.messages];
  }

  public addMessage(record: MessageRecord): MessageRecord[] {
    const existingIndex = this.messages.findIndex((m) => m.id === record.id);
    if (existingIndex >= 0) {
      // If already recorded as OUTGOING, incoming radio reflection/echo should never duplicate it
      if (this.messages[existingIndex].direction === 'OUTGOING' && record.direction === 'INCOMING') {
        this.messages[existingIndex].status = 'DELIVERED';
        this.messages[existingIndex].deliveredAt = Date.now();
        return [...this.messages];
      }
      // Drop duplicate record
      return [...this.messages];
    }

    this.messages.push(record);
    if (this.messages.length > 200) {
      this.messages.shift();
    }
    return [...this.messages];
  }

  public clearMessages(targetId?: string): MessageRecord[] {
    if (!targetId || targetId === 'ALL') {
      this.messages = [];
    } else if (targetId === 'BROADCAST' || targetId === '#all') {
      this.messages = this.messages.filter(
        m => m.packet.destinationId !== 'BROADCAST' && m.packet.destinationId !== '#all'
      );
    } else if (targetId.startsWith('#')) {
      this.messages = this.messages.filter(
        m => m.packet.destinationId !== targetId && !m.packet.payload.includes(`[${targetId.toUpperCase()}]`)
      );
    } else {
      this.messages = this.messages.filter(
        m => {
          const isBroadcast = m.packet.destinationId === 'BROADCAST' || m.packet.destinationId === '#all' || m.packet.destinationId.startsWith('#');
          if (isBroadcast) return true; // Preserve all broadcast messages
          const isWithTarget =
            m.packet.destinationId === targetId ||
            m.packet.senderId === targetId ||
            m.packet.senderName === targetId;
          return !isWithTarget;
        }
      );
    }
    return [...this.messages];
  }

  public deleteMessage(messageId: string): MessageRecord[] {
    this.messages = this.messages.filter(
      m => m.id !== messageId && m.packet.messageId !== messageId
    );
    return [...this.messages];
  }

  public updateMessageStatus(
    messageId: string,
    status: MessageRecord['status'],
    latencyMs?: number
  ): MessageRecord[] {
    const idx = this.messages.findIndex(
      m => m.id === messageId || m.packet.messageId === messageId
    );
    if (idx !== -1) {
      this.messages[idx].status = status;
      if (latencyMs !== undefined) {
        this.messages[idx].latencyMs = latencyMs;
      }
      if (status === 'DELIVERED') {
        this.messages[idx].deliveredAt = Date.now();
      }
      if (status === 'ACKNOWLEDGED') {
        this.messages[idx].acknowledgedAt = Date.now();
      }
    }
    return [...this.messages];
  }

  public getMetrics(): NetworkMetrics {
    return { ...this.metrics };
  }

  public recordMetricEvent(event: {
    type: 'SENT' | 'RECEIVED' | 'DELIVERED' | 'ACK' | 'FAIL' | 'DUPLICATE' | 'EXPIRED' | 'RELAY';
    latencyMs?: number;
    activeLinks?: number;
  }) {
    if (event.type === 'SENT') this.metrics.totalSent++;
    if (event.type === 'RECEIVED') this.metrics.totalReceived++;
    if (event.type === 'DELIVERED') this.metrics.totalDelivered++;
    if (event.type === 'ACK') this.metrics.totalAcknowledged++;
    if (event.type === 'FAIL') this.metrics.totalFailed++;
    if (event.type === 'RELAY') this.metrics.totalRelayed++;
    if (event.type === 'DUPLICATE') this.metrics.duplicatesDropped++;
    if (event.type === 'EXPIRED') this.metrics.expiredTtlDropped++;

    if (event.latencyMs !== undefined && event.latencyMs > 0) {
      this.metrics.avgLatencyMs =
        this.metrics.avgLatencyMs === 0
          ? event.latencyMs
          : Math.round(this.metrics.avgLatencyMs * 0.7 + event.latencyMs * 0.3);
    }

    if (event.activeLinks !== undefined) {
      this.metrics.activeLinksCount = event.activeLinks;
    }

    const totalAttempts = this.metrics.totalDelivered + this.metrics.totalFailed;
    if (totalAttempts > 0) {
      this.metrics.packetDeliveryRatio = Math.round(
        (this.metrics.totalDelivered / totalAttempts) * 100
      );
    }

    this.metrics.lastUpdated = Date.now();
  }

  /**
   * BitChat-inspired Panic / Emergency Wipe:
   * Instantly purges all message history, routing metrics, and local cache
   * for operational security in crisis situations.
   */
  public wipeAllData() {
    this.messages = [];
    this.peers.clear();
    this.metrics = {
      totalSent: 0,
      totalReceived: 0,
      totalDelivered: 0,
      totalAcknowledged: 0,
      totalFailed: 0,
      totalRelayed: 0,
      duplicatesDropped: 0,
      expiredTtlDropped: 0,
      avgLatencyMs: 0,
      packetDeliveryRatio: 100,
      discoverySuccessRate: 100,
      activeLinksCount: 0,
      lastUpdated: Date.now(),
    };
  }
}

export const storageService = new StorageService();
