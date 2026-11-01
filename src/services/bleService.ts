import { bleBridge, BleBridgeEvents } from './nativeBleBridge';
import { storageService, LocalNodeConfig } from './storageService';
import { outboxService } from './outboxService';
import { PeerNode, RadioState, NodeRole } from '../types/ble';
import { ResQNetPacket, MessageRecord, MessagePriority } from '../types/message';
import { NetworkMetrics } from '../types/metrics';
import { createPacket, createAckPacket } from '../protocol/packetSchema';

type StateListener = (state: {
  radioState: RadioState;
  peers: PeerNode[];
  messages: MessageRecord[];
  metrics: NetworkMetrics;
  localConfig: LocalNodeConfig;
  outboxCount: number;
}) => void;

class BleService {
  private localConfig: LocalNodeConfig;
  private radioState: RadioState;
  private peers: Map<string, PeerNode> = new Map();
  private processedMessageIds: Set<string> = new Set();
  private listeners: Set<StateListener> = new Set();

  constructor() {
    this.localConfig = storageService.getLocalConfig();
    this.radioState = {
      isSupported: true,
      isEnabled: true,
      isAdvertising: false,
      isScanning: false,
      autoConnect: true,
      scanIntervalMs: 8000,
      connectedCount: 0,
      discoveredCount: 0,
      operatingMode: bleBridge.hasNativeBleSupport() ? 'NATIVE_BLE' : 'SIMULATION_TESTBED',
    };

    this.initBridge();
    this.initializeIdentity();

    outboxService.onFlushRequested = () => {
      const connectedPeers = Array.from(this.peers.values()).filter(
        (p) => p.connectionState === 'CONNECTED'
      );
      if (connectedPeers.length > 0) {
        const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
        outboxService
          .flush(connectedPeers, this.localConfig.nodeId, isSim)
          .then((flushed) => {
            if (flushed > 0) this.notifyState();
          });
      }
    };
  }

  public async initializeIdentity(): Promise<{ fixedId: string; hasConfiguredUsername: boolean }> {
    try {
      const fixedId = await bleBridge.getFixedDeviceId();
      if (fixedId) {
        storageService.setFixedDeviceId(fixedId);
      }
      const savedName = await bleBridge.getSavedUsername();
      if (savedName && savedName.trim().length > 0) {
        storageService.setSavedUsername(savedName.trim());
      }
      this.localConfig = storageService.getLocalConfig();
      this.notifyState();
      return {
        fixedId: this.localConfig.nodeId,
        hasConfiguredUsername: this.localConfig.hasConfiguredUsername,
      };
    } catch (e) {
      console.warn('Failed to initialize identity:', e);
      return {
        fixedId: this.localConfig.nodeId,
        hasConfiguredUsername: this.localConfig.hasConfiguredUsername,
      };
    }
  }

  public async initializeFixedDeviceId(): Promise<string> {
    const res = await this.initializeIdentity();
    return res.fixedId;
  }

  private initBridge() {
    const events: BleBridgeEvents = {
      onNodeDiscovered: (node: PeerNode) => {
        const existing = this.peers.get(node.id);
        const cleanName =
          node.name && !node.name.startsWith('Android-') && !node.name.startsWith('Device')
            ? node.name
            : existing?.name && !existing.name.startsWith('Android-')
            ? existing.name
            : node.name;

        const isKnownPrefix = (id?: string) => !!id && (id.startsWith('ERVO-') || id.startsWith('RESQ-'));
        const fixedDeviceId =
          isKnownPrefix(node.nodeId)
            ? node.nodeId
            : isKnownPrefix(existing?.nodeId)
            ? existing!.nodeId
            : `ERVO-${node.id.slice(-4).replace(':', '').toUpperCase()}`;

        const merged: PeerNode = {
          ...node,
          name: cleanName,
          nodeId: fixedDeviceId,
          connectionState: existing ? existing.connectionState : 'DISCOVERED',
          packetsReceived: existing ? existing.packetsReceived : 0,
          packetsSent: existing ? existing.packetsSent : 0,
        };
        this.peers.set(node.id, merged);
        this.updateCounts();

        // Auto-connect if enabled
        if (
          this.radioState.autoConnect &&
          merged.connectionState === 'DISCOVERED'
        ) {
          this.connectToPeer(node.id);
        }

        this.notifyState();
      },

      onNodeConnected: (deviceAddress: string, nodeId: string) => {
        const peer = this.peers.get(deviceAddress);
        const isKnownPrefix = (id?: string) => !!id && (id.startsWith('ERVO-') || id.startsWith('RESQ-'));
        const fixedDeviceId =
          isKnownPrefix(peer?.nodeId)
            ? peer!.nodeId
            : isKnownPrefix(nodeId)
            ? nodeId
            : `ERVO-${deviceAddress.slice(-4).replace(':', '').toUpperCase()}`;

        const cleanName =
          nodeId &&
          !nodeId.startsWith('Android-') &&
          !nodeId.startsWith('Device') &&
          !nodeId.startsWith('NODE-') &&
          !isKnownPrefix(nodeId)
            ? nodeId
            : peer?.name &&
              !peer.name.startsWith('Android-') &&
              !peer.name.startsWith('Device')
            ? peer.name
            : `User (${fixedDeviceId.replace('ERVO-', '').replace('RESQ-', '')})`;

        if (peer) {
          peer.connectionState = 'CONNECTED';
          peer.name = cleanName;
          peer.nodeId = fixedDeviceId;
          peer.lastSeen = Date.now();
        } else {
          this.peers.set(deviceAddress, {
            id: deviceAddress,
            name: cleanName,
            nodeId: fixedDeviceId,
            role: 'Field Worker',
            rssi: -65,
            distanceMeters: 2.1,
            connectionState: 'CONNECTED',
            lastSeen: Date.now(),
            packetsReceived: 0,
            packetsSent: 0,
          });
        }
        this.updateCounts();
        storageService.recordMetricEvent({
          type: 'ACK',
          activeLinks: this.radioState.connectedCount,
        });

        // Send lightweight handshake ping after 350ms to allow link to settle
        const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
        setTimeout(() => {
          const handshakePacket = createPacket({
            senderId: this.localConfig.deviceId || this.localConfig.nodeId,
            senderName: this.localConfig.displayName || this.localConfig.name,
            destinationId: fixedDeviceId,
            payload: `HANDSHAKE:${this.localConfig.displayName || this.localConfig.name}`,
            messageType: 'PING',
            ttl: 1,
          });
          bleBridge.sendPacket(deviceAddress, handshakePacket, this.localConfig.nodeId, isSim).catch(() => {});
        }, 350);

        // Opportunistic DTN Flush when node connects (BitChat / Thematic Review DTN routing)
        setTimeout(() => {
          const connectedPeers = Array.from(this.peers.values()).filter(
            (p) => p.connectionState === 'CONNECTED'
          );
          outboxService
            .flush(connectedPeers, this.localConfig.nodeId, isSim)
            .then((flushed) => {
              if (flushed > 0) this.notifyState();
            });
        }, 600);

        this.notifyState();
      },

      onNodeDisconnected: (deviceAddress: string) => {
        const peer = this.peers.get(deviceAddress);
        if (peer) {
          peer.connectionState = 'DISCONNECTED';
        }
        this.updateCounts();
        this.notifyState();
      },

      onMessageReceived: (packet: ResQNetPacket, rawPayload: string) => {
        this.handleIncomingPacket(packet);
      },

      onMessageDelivered: (targetAddress: string, latencyMs: number) => {
        storageService.recordMetricEvent({ type: 'DELIVERED', latencyMs });
        this.notifyState();
      },

      onScanStatusChanged: (isScanning: boolean) => {
        this.radioState.isScanning = isScanning;
        this.notifyState();
      },

      onAdvertisingStatusChanged: (isAdvertising: boolean) => {
        this.radioState.isAdvertising = isAdvertising;
        this.notifyState();
      },
    };

    bleBridge.registerListeners(events);
  }

  private updateCounts() {
    let connected = 0;
    for (const peer of this.peers.values()) {
      if (peer.connectionState === 'CONNECTED') connected++;
    }
    this.radioState.connectedCount = connected;
    this.radioState.discoveredCount = this.peers.size;
  }

  private isSelf(senderId?: string, senderName?: string): boolean {
    if (!senderId && !senderName) return false;
    const myDeviceId = this.localConfig.deviceId;
    const myNodeId = this.localConfig.nodeId;
    const myDisplayName = this.localConfig.displayName;
    const myName = this.localConfig.name;

    return (
      (!!myDeviceId && senderId === myDeviceId) ||
      (!!myNodeId && senderId === myNodeId) ||
      (!!myDisplayName && (senderId === myDisplayName || senderName === myDisplayName)) ||
      (!!myName && (senderId === myName || senderName === myName))
    );
  }

  private handleIncomingPacket(packet: ResQNetPacket) {
    // 1. Loopback / self-echo suppression:
    // Drop any packet that originated from ourselves immediately!
    if (this.isSelf(packet.senderId, packet.senderName)) {
      this.processedMessageIds.add(packet.messageId);
      return;
    }

    // 2. Duplicate detection & loop suppression
    if (this.processedMessageIds.has(packet.messageId)) {
      storageService.recordMetricEvent({ type: 'DUPLICATE' });
      return;
    }
    this.processedMessageIds.add(packet.messageId);

    // Update peer's username if packet contains human senderName
    if (packet.senderName) {
      for (const peer of this.peers.values()) {
        if (
          peer.nodeId === packet.senderId ||
          peer.name === packet.senderId ||
          peer.id === packet.senderId
        ) {
          peer.name = packet.senderName;
          this.notifyState();
          break;
        }
      }
    }

    // Protocol PING (handshake) - used purely for username exchange
    if (packet.messageType === 'PING') {
      return;
    }

    const isForMe =
      packet.destinationId === this.localConfig.nodeId ||
      packet.destinationId === (this.localConfig.deviceId || '') ||
      packet.destinationId === this.localConfig.displayName ||
      packet.destinationId === this.localConfig.name;
    const isBroadcast =
      packet.destinationId === 'BROADCAST' ||
      packet.destinationId === '#all' ||
      packet.destinationId.startsWith('#');
    const isAck = packet.messageType === 'ACK';

    // 2. ACK Handling
    if (isAck) {
      if (isForMe) {
        const match = packet.payload.match(/^ACK:(.+)$/);
        if (match) {
          const originalMsgId = match[1];
          storageService.updateMessageStatus(originalMsgId, 'ACKNOWLEDGED');
          storageService.recordMetricEvent({ type: 'ACK' });
          this.notifyState();
          return;
        }
      } else if (packet.ttl > 1) {
        // Relay ACK across mesh back to original sender
        this.relayPacketAcrossMesh(packet);
        return;
      }
    }

    // 3. Message is for this node or a broadcast:
    if (isForMe || isBroadcast) {
      const record: MessageRecord = {
        id: packet.messageId,
        packet: { ...packet, hopCount: packet.hopCount },
        direction: 'INCOMING',
        status: 'DELIVERED',
        createdAt: Date.now(),
        deliveredAt: Date.now(),
      };

      storageService.addMessage(record);
      storageService.recordMetricEvent({ type: 'RECEIVED' });

      // Automatically send ACK back to sender for point-to-point messages
      if (isForMe && !isAck) {
        const ack = createAckPacket(packet, this.localConfig.nodeId);
        this.routePacketToDestination(ack);
      }
    }

    // 4. BLE Mesh Multi-Hop Forwarding:
    // If packet is a broadcast or destined for another node, forward to peers if TTL allows
    if ((isBroadcast || !isForMe) && packet.ttl > 1) {
      this.relayPacketAcrossMesh(packet);
    }

    this.notifyState();
  }

  private async relayPacketAcrossMesh(packet: ResQNetPacket) {
    if (packet.ttl <= 1) {
      storageService.recordMetricEvent({ type: 'EXPIRED' });
      return;
    }

    // Never relay packets that originated from ourselves
    if (this.isSelf(packet.senderId, packet.senderName)) {
      return;
    }

    const relayedPacket: ResQNetPacket = {
      ...packet,
      ttl: packet.ttl - 1,
      hopCount: packet.hopCount + 1,
    };

    storageService.recordMetricEvent({ type: 'RELAY' });

    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';

    // Forward to all active mesh neighbors except original sender
    for (const peer of this.peers.values()) {
      if (
        peer.connectionState === 'CONNECTED' &&
        peer.nodeId !== packet.senderId &&
        peer.id !== packet.senderId &&
        peer.name !== packet.senderId &&
        peer.name !== packet.senderName
      ) {
        try {
          await bleBridge.sendPacket(
            peer.id,
            relayedPacket,
            this.localConfig.nodeId,
            isSim
          );
        } catch (e) {
          console.warn('Mesh forward failed to peer:', peer.nodeId, e);
        }
      }
    }
  }

  private async routePacketToDestination(packet: ResQNetPacket): Promise<boolean> {
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    const isBroadcast =
      packet.destinationId === 'BROADCAST' ||
      packet.destinationId === '#all' ||
      packet.destinationId.startsWith('#');

    if (isBroadcast) {
      const res = await bleBridge.broadcastPacket(
        packet,
        this.localConfig.nodeId,
        this.radioState.connectedCount,
        isSim
      );
      return res.deliveredCount > 0 || res.totalNodes > 0 || isSim;
    }

    // Find direct peer
    let directPeer: PeerNode | undefined;
    for (const p of this.peers.values()) {
      if (
        (p.nodeId === packet.destinationId ||
          p.id === packet.destinationId ||
          p.name === packet.destinationId) &&
        p.connectionState === 'CONNECTED'
      ) {
        directPeer = p;
        break;
      }
    }

    if (directPeer) {
      await bleBridge.sendPacket(
        directPeer.id,
        packet,
        this.localConfig.nodeId,
        isSim
      );
      return true;
    } else {
      // Check if peer is found by ID or name even if not explicitly marked CONNECTED
      const fallbackPeer = Array.from(this.peers.values()).find(
        (p) =>
          p.nodeId === packet.destinationId ||
          p.id === packet.destinationId ||
          p.name === packet.destinationId
      );
      if (fallbackPeer) {
        try {
          await bleBridge.sendPacket(
            fallbackPeer.id,
            packet,
            this.localConfig.nodeId,
            isSim
          );
          return true;
        } catch (e) {
          // Fall through to relay
        }
      }

      // Multi-hop routing: forward to connected mesh neighbors
      let sentCount = 0;
      for (const peer of this.peers.values()) {
        if (peer.connectionState === 'CONNECTED') {
          try {
            await bleBridge.sendPacket(
              peer.id,
              packet,
              this.localConfig.nodeId,
              isSim
            );
            sentCount++;
          } catch (e) {
            console.warn('Mesh forward failed to peer:', peer.id);
          }
        }
      }
      return sentCount > 0;
    }
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    // Send immediate state
    listener(this.getStateSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyState() {
    const snapshot = this.getStateSnapshot();
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch (e) {
        console.error('Error in state listener:', e);
      }
    }
  }

  public getStateSnapshot() {
    return {
      radioState: { ...this.radioState },
      peers: Array.from(this.peers.values()),
      messages: storageService.getMessages(),
      metrics: storageService.getMetrics(),
      localConfig: { ...this.localConfig },
      outboxCount: outboxService.getPendingCount(),
    };
  }

  // --- Controls ---

  public async setOperatingMode(mode: 'NATIVE_BLE' | 'SIMULATION_TESTBED') {
    this.radioState.operatingMode = mode;
    this.notifyState();
  }

  public async toggleAutoScan(): Promise<boolean> {
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    if (this.radioState.isScanning) {
      await bleBridge.stopAutoScan(isSim);
      this.radioState.isScanning = false;
    } else {
      await bleBridge.startAutoScan(this.radioState.autoConnect, isSim);
      this.radioState.isScanning = true;
    }
    this.notifyState();
    return this.radioState.isScanning;
  }

  public async toggleAdvertising(): Promise<boolean> {
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    if (this.radioState.isAdvertising) {
      await bleBridge.stopAdvertising(isSim);
      this.radioState.isAdvertising = false;
    } else {
      await bleBridge.startAdvertising(
        this.localConfig.deviceId || this.localConfig.nodeId,
        this.localConfig.role,
        this.localConfig.displayName || this.localConfig.name,
        isSim
      );
      this.radioState.isAdvertising = true;
    }
    this.notifyState();
    return this.radioState.isAdvertising;
  }

  public setAutoConnect(enabled: boolean) {
    this.radioState.autoConnect = enabled;
    this.notifyState();
  }

  public async connectToPeer(deviceAddress: string): Promise<boolean> {
    const peer = this.peers.get(deviceAddress);
    if (peer) {
      peer.connectionState = 'CONNECTING';
      this.notifyState();
    }
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    return await bleBridge.connectNode(deviceAddress, isSim);
  }

  public async disconnectPeer(deviceAddress: string): Promise<boolean> {
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    return await bleBridge.disconnectNode(deviceAddress, isSim);
  }

  public async transmitMessage(params: {
    targetId: string; // 'BROADCAST' or deviceAddress / nodeId / channel
    payload: string;
    priority?: MessagePriority;
    ttl?: number;
  }): Promise<boolean> {
    const isBroadcast =
      params.targetId === 'BROADCAST' ||
      params.targetId === '#all' ||
      params.targetId.startsWith('#');
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';

    // Find destination nodeId and target address
    let destNodeId = isBroadcast ? 'BROADCAST' : params.targetId;
    let targetAddress: string | null = null;
    let targetPeer: PeerNode | undefined;

    if (!isBroadcast) {
      targetPeer = Array.from(this.peers.values()).find(
        (p) =>
          p.id === params.targetId ||
          p.nodeId === params.targetId ||
          p.name === params.targetId
      );
      if (targetPeer) {
        destNodeId = targetPeer.nodeId;
        targetAddress = targetPeer.id;
      } else {
        destNodeId = params.targetId;
        if (params.targetId.includes(':')) {
          targetAddress = params.targetId;
        }
      }
    }

    // If channel-based (e.g. #emergency, #medical, #supplies), prefix payload with channel tag
    let formattedPayload = params.payload;
    if (params.targetId.startsWith('#') && params.targetId !== '#all') {
      formattedPayload = `[${params.targetId.toUpperCase()}] ${params.payload}`;
    }

    const packet = createPacket({
      senderId: this.localConfig.deviceId || this.localConfig.nodeId,
      senderName: this.localConfig.displayName || this.localConfig.name,
      destinationId: destNodeId,
      payload: formattedPayload,
      priority: params.priority || (params.targetId === '#emergency' ? 'URGENT' : 'NORMAL'),
      ttl: params.ttl || 3,
      messageType: params.priority === 'CRITICAL_SOS' ? 'ALERT' : 'TEXT',
    });

    // Mark as processed immediately so incoming radio reflections are suppressed
    this.processedMessageIds.add(packet.messageId);

    const record: MessageRecord = {
      id: packet.messageId,
      packet,
      direction: 'OUTGOING',
      status: 'SENDING',
      targetAddress: targetAddress || undefined,
      createdAt: Date.now(),
    };

    storageService.addMessage(record);
    storageService.recordMetricEvent({ type: 'SENT' });
    this.notifyState();

    // On-demand connection if target peer is discovered but not yet connected
    if (!isBroadcast && targetAddress && targetPeer && targetPeer.connectionState !== 'CONNECTED' && !isSim) {
      try {
        console.log(`Connecting to peer ${targetAddress} before transmitting...`);
        await this.connectToPeer(targetAddress);
        // Wait up to 1200ms for connection to complete
        for (let i = 0; i < 12; i++) {
          await new Promise<void>((res) => setTimeout(() => res(), 100));
          const updated = this.peers.get(targetAddress);
          if (updated?.connectionState === 'CONNECTED') break;
        }
      } catch (e) {
        console.warn('On-demand connection attempt failed:', e);
      }
    }

    // Broadcast on-demand: if 0 connected, trigger connection to any discovered peers
    if (isBroadcast && this.radioState.connectedCount === 0 && !isSim) {
      const discovered = Array.from(this.peers.values()).filter((p) => p.connectionState === 'DISCOVERED');
      for (const p of discovered) {
        this.connectToPeer(p.id).catch(() => {});
      }
      if (discovered.length > 0) {
        for (let i = 0; i < 10; i++) {
          await new Promise<void>((res) => setTimeout(() => res(), 100));
          if (this.radioState.connectedCount > 0) break;
        }
      }
    }

    // Try transmission immediately
    try {
      const delivered = await this.routePacketToDestination(packet);
      if (delivered) {
        storageService.updateMessageStatus(packet.messageId, 'DELIVERED', 45);
        this.notifyState();
        return true;
      } else {
        throw new Error('No active route or delivery reported 0 nodes');
      }
    } catch (e: any) {
      // Opportunistic DTN Store-and-Forward: enqueue into outbox
      console.log('Immediate delivery unavailable, queued in DTN Outbox:', e.message);
      outboxService.enqueue(packet, targetAddress || undefined);
      storageService.updateMessageStatus(packet.messageId, 'QUEUED');
      storageService.recordMetricEvent({ type: 'FAIL' });
      this.notifyState();
      return false;
    }
  }

  /**
   * Manually retries transmission of an outbox or failed message
   */
  public async retryMessage(messageId: string): Promise<boolean> {
    const record = storageService
      .getMessages()
      .find((m) => m.id === messageId || m.packet.messageId === messageId);
    if (!record) return false;

    // Immediately reflect SENDING status
    storageService.updateMessageStatus(messageId, 'SENDING');
    this.notifyState();

    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    const packet = record.packet;
    const isBroadcast =
      packet.destinationId === 'BROADCAST' ||
      packet.destinationId === '#all' ||
      packet.destinationId.startsWith('#');

    // On-demand connection if target peer is known and not connected
    let targetAddress = record.targetAddress;
    if (!isBroadcast) {
      const targetPeer = Array.from(this.peers.values()).find(
        (p) =>
          p.id === packet.destinationId ||
          p.nodeId === packet.destinationId ||
          p.name === packet.destinationId ||
          (targetAddress && p.id === targetAddress)
      );
      if (targetPeer && targetPeer.connectionState !== 'CONNECTED' && !isSim) {
        try {
          await this.connectToPeer(targetPeer.id);
          for (let i = 0; i < 10; i++) {
            await new Promise<void>((res) => setTimeout(() => res(), 100));
            const updated = this.peers.get(targetPeer.id);
            if (updated?.connectionState === 'CONNECTED') break;
          }
        } catch (e) {
          console.warn('Retry on-demand connection failed:', e);
        }
      }
    }

    try {
      const delivered = await this.routePacketToDestination(packet);
      if (delivered) {
        outboxService.dequeue(messageId);
        storageService.updateMessageStatus(messageId, 'DELIVERED', 45);
        this.notifyState();
        return true;
      } else {
        throw new Error('Immediate route delivery reported failure');
      }
    } catch (e: any) {
      outboxService.enqueue(packet, targetAddress);
      storageService.updateMessageStatus(messageId, 'QUEUED');
      storageService.recordMetricEvent({ type: 'FAIL' });
      this.notifyState();
      return false;
    }
  }

  public setLocalRole(role: NodeRole) {
    this.localConfig.role = role;
    storageService.updateLocalConfig({ role });
    this.notifyState();
  }

  public async saveCompulsoryUsername(username: string): Promise<boolean> {
    const cleanName = username.trim();
    if (!cleanName || cleanName.length < 2) return false;

    // Persist to Android SharedPreferences
    await bleBridge.saveUsername(cleanName);
    storageService.setSavedUsername(cleanName);
    this.localConfig = storageService.getLocalConfig();

    // Restart advertising with the official username
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    if (this.radioState.isAdvertising) {
      await bleBridge.stopAdvertising(isSim);
    }
    await bleBridge.startAdvertising(
      this.localConfig.deviceId || this.localConfig.nodeId,
      this.localConfig.role,
      cleanName,
      isSim
    );
    this.radioState.isAdvertising = true;

    // Start auto-scan if not already scanning
    if (!this.radioState.isScanning) {
      await bleBridge.startAutoScan(this.radioState.autoConnect, isSim);
      this.radioState.isScanning = true;
    }

    this.notifyState();
    return true;
  }

  public async setDisplayName(displayName: string): Promise<boolean> {
    const cleanName = displayName.trim();
    if (!cleanName) return false;
    return await this.saveCompulsoryUsername(cleanName);
  }

  /**
   * Clear message history (for active channel, peer, or all messages)
   */
  public clearMessages(targetId?: string) {
    storageService.clearMessages(targetId);
    this.notifyState();
  }

  /**
   * Delete an individual message by ID
   */
  public deleteMessage(messageId: string) {
    storageService.deleteMessage(messageId);
    this.notifyState();
  }

  /**
   * BitChat-inspired Panic / Emergency Wipe:
   * Instantly purges all message history, routing metrics, active peers, and outbox.
   */
  public wipeAllData() {
    this.peers.clear();
    this.processedMessageIds.clear();
    outboxService.clear();
    storageService.wipeAllData();
    this.updateCounts();
    this.notifyState();
  }
}

export const bleService = new BleService();

