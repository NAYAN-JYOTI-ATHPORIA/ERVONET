import { ResQNetPacket } from '../types/message';
import { PeerNode } from '../types/ble';
import { bleBridge } from './nativeBleBridge';
import { storageService } from './storageService';

export interface OutboxItem {
  id: string; // Message ID
  packet: ResQNetPacket;
  targetAddress?: string;
  queuedAt: number;
  retryCount: number;
  maxRetries: number;
  expiresAt: number;
}

const OUTBOX_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours retention in DTN buffer
const MAX_OUTBOX_SIZE = 50;

class OutboxService {
  private queue: Map<string, OutboxItem> = new Map();
  private isFlushing = false;
  private autoFlushTimer: any = null;
  public onFlushRequested?: () => void;

  constructor() {
    this.startPeriodicFlush();
  }

  private startPeriodicFlush() {
    if (this.autoFlushTimer) clearInterval(this.autoFlushTimer);
    this.autoFlushTimer = setInterval(() => {
      if (this.queue.size > 0 && this.onFlushRequested) {
        this.onFlushRequested();
      }
    }, 5000);
  }

  /**
   * Adds an undelivered packet to the opportunistic Store-and-Forward queue
   */
  public enqueue(packet: ResQNetPacket, targetAddress?: string): boolean {
    // Evict oldest if capacity reached
    if (this.queue.size >= MAX_OUTBOX_SIZE) {
      const oldestKey = this.queue.keys().next().value;
      if (oldestKey) {
        this.queue.delete(oldestKey);
      }
    }

    const item: OutboxItem = {
      id: packet.messageId,
      packet,
      targetAddress,
      queuedAt: Date.now(),
      retryCount: 0,
      maxRetries: 5,
      expiresAt: Date.now() + OUTBOX_TTL_MS,
    };

    this.queue.set(packet.messageId, item);
    return true;
  }

  /**
   * Removes a delivered or acknowledged packet from the outbox
   */
  public dequeue(messageId: string): boolean {
    return this.queue.delete(messageId);
  }

  public getPendingCount(): number {
    return this.queue.size;
  }

  public getPendingItems(): OutboxItem[] {
    return Array.from(this.queue.values());
  }

  /**
   * Automatically flushes opportunistic Store-and-Forward messages
   * when mesh nodes become available or connection state updates.
   */
  public async flush(
    connectedPeers: PeerNode[],
    localNodeId: string,
    isSim: boolean
  ): Promise<number> {
    if (this.isFlushing || this.queue.size === 0 || connectedPeers.length === 0) {
      return 0;
    }

    this.isFlushing = true;
    let flushedCount = 0;
    const now = Date.now();

    try {
      const items = Array.from(this.queue.values());
      for (const item of items) {
        // Purge expired DTN packets
        if (now > item.expiresAt) {
          this.queue.delete(item.id);
          storageService.recordMetricEvent({ type: 'EXPIRED' });
          continue;
        }

        const isBroadcast = item.packet.destinationId === 'BROADCAST';

        if (isBroadcast) {
          try {
            await bleBridge.broadcastPacket(
              item.packet,
              localNodeId,
              connectedPeers.length,
              isSim
            );
            this.queue.delete(item.id);
            flushedCount++;
            storageService.updateMessageStatus(item.id, 'DELIVERED', 50);
          } catch (e) {
            item.retryCount++;
            if (item.retryCount >= item.maxRetries) {
              this.queue.delete(item.id);
              storageService.updateMessageStatus(item.id, 'FAILED');
              storageService.recordMetricEvent({ type: 'FAIL' });
            }
          }
        } else {
          // Direct or multi-hop: check if destination is directly connected or route via available peer
          let target = connectedPeers.find(
            (p) =>
              p.id === item.packet.destinationId ||
              p.nodeId === item.packet.destinationId ||
              p.id === item.targetAddress
          );

          if (!target && connectedPeers.length > 0) {
            // Forward through first available connected mesh router
            target = connectedPeers[0];
          }

          if (target) {
            try {
              await bleBridge.sendPacket(
                target.id,
                item.packet,
                localNodeId,
                isSim
              );
              this.queue.delete(item.id);
              flushedCount++;
              storageService.updateMessageStatus(item.id, 'DELIVERED', 65);
            } catch (e) {
              item.retryCount++;
              if (item.retryCount >= item.maxRetries) {
                this.queue.delete(item.id);
                storageService.updateMessageStatus(item.id, 'FAILED');
                storageService.recordMetricEvent({ type: 'FAIL' });
              }
            }
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }

    return flushedCount;
  }

  public clear() {
    this.queue.clear();
  }
}

export const outboxService = new OutboxService();

