export interface NetworkMetrics {
  totalSent: number;
  totalReceived: number;
  totalDelivered: number;
  totalAcknowledged: number;
  totalFailed: number;
  totalRelayed: number;
  duplicatesDropped: number;
  expiredTtlDropped: number;
  avgLatencyMs: number;
  packetDeliveryRatio: number; // percentage (0 - 100)
  discoverySuccessRate: number; // percentage
  activeLinksCount: number;
  lastUpdated: number;
}

