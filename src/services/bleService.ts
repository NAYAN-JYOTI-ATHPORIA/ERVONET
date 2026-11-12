import { bleBridge, BleBridgeEvents } from './nativeBleBridge';
import { storageService, LocalNodeConfig } from './storageService';
import { outboxService } from './outboxService';
import { PeerNode, RadioState, NodeRole } from '../types/ble';
import {
  ResQNetPacket,
  MessageRecord,
  MessagePriority,
  MessageType,
  RelayNodeTelemetry,
  MapServerStatus,
} from '../types/message';
import { NetworkMetrics } from '../types/metrics';
import { createPacket, createAckPacket } from '../protocol/packetSchema';
import { decryptPayloadHex } from '../protocol/security';
import { locationService } from './locationService';
import { routingService } from './routingService';

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
  private relayTelemetry: Map<string, RelayNodeTelemetry> = new Map();
  private mapServerStatus: MapServerStatus | null = null;
  private processedMessageIds: Set<string> = new Set();
  private listeners: Set<StateListener> = new Set();
  private pruneTimer: any = null;
  private locationBeaconTimer: any = null;
  private keepAliveWatchdogTimer: any = null;

  constructor() {
    this.localConfig = storageService.getLocalConfig();
    this.radioState = {
      isSupported: true,
      isEnabled: true,
      isAdvertising: false,
      isScanning: false,
      autoConnect: true,
      scanIntervalMs: 25000,
      connectedCount: 0,
      discoveredCount: 0,
      operatingMode: bleBridge.hasNativeBleSupport() ? 'NATIVE_BLE' : 'SIMULATION_TESTBED',
    };

    this.initBridge();
    this.initializeIdentity();
    this.startStalePeerPruner();
    this.startLocationBeacon();
    this.startKeepAliveWatchdog();

    outboxService.onFlushRequested = () => {
      const connectedPeers = this.getDeduplicatedPeers().filter(
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

  private isAppNodeId(id?: string): boolean {
    return !!id && (id.startsWith('ERVO-') || id.startsWith('RESQ-'));
  }

  private isRelayNode(id?: string, name?: string): boolean {
    return (
      /^ERVO-ES/i.test(id || '') ||
      /^RESQ-ES/i.test(id || '') ||
      /ESP32|RELAY/i.test(name || '')
    );
  }

  private initBridge() {
    const events: BleBridgeEvents = {
      onNodeDiscovered: (node: PeerNode) => {
        // 1. SELF-FILTER: Immediately drop our own device if scanner picks it up
        if (this.isSelf(node.nodeId, node.name) || this.isSelf(node.id)) {
          return;
        }

        // 2. DEDUPLICATION: Check if this user is already tracked under any key (either same MAC or same canonical nodeId / name)
        let existingKey: string | null = null;
        let existing: PeerNode | undefined;

        for (const [key, p] of this.peers.entries()) {
          if (
            key === node.id ||
            (node.nodeId && p.nodeId && p.nodeId === node.nodeId) ||
            (node.name && p.name && p.name === node.name && !node.name.startsWith('User-') && !node.name.startsWith('ERVO-'))
          ) {
            existingKey = key;
            existing = p;
            break;
          }
        }

        // STRICT APP-ONLY FILTER: Discard any node that does not have an official ERVONET/RESQNET device ID
        if (!this.isAppNodeId(node.nodeId) && !this.isAppNodeId(existing?.nodeId)) {
          return;
        }

        const fixedDeviceId = this.isAppNodeId(node.nodeId) ? node.nodeId : existing!.nodeId;

        // Verify again with resolved fixedDeviceId
        if (this.isSelf(fixedDeviceId)) {
          return;
        }

        const cleanName =
          node.name && !node.name.startsWith('Android-') && !node.name.startsWith('Device') && !node.name.startsWith('ERVO-')
            ? node.name
            : existing?.name && !existing.name.startsWith('Android-') && !existing.name.startsWith('Device') && !existing.name.startsWith('ERVO-')
              ? existing.name
              : node.name;

        // If the device rotated its MAC address, purge the old MAC key so the user is never duplicated
        if (existingKey && existingKey !== node.id) {
          this.peers.delete(existingKey);
        }

        const merged: PeerNode = {
          ...node,
          name: cleanName,
          nodeId: fixedDeviceId,
          connectionState: existing ? existing.connectionState : 'DISCOVERED',
          packetsReceived: existing ? existing.packetsReceived : 0,
          packetsSent: existing ? existing.packetsSent : 0,
          lastSeen: Date.now(),
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
        // Discard self
        if (this.isSelf(nodeId) || this.isSelf(deviceAddress)) {
          return;
        }

        // Clean up any stale MAC key for the same nodeId
        for (const [key, p] of this.peers.entries()) {
          if (key !== deviceAddress && (p.nodeId === nodeId || (p.name === nodeId && !p.name.startsWith('User-')))) {
            this.peers.delete(key);
          }
        }

        const peer = this.peers.get(deviceAddress);

        const fixedDeviceId = this.isAppNodeId(peer?.nodeId)
          ? peer!.nodeId
          : this.isAppNodeId(nodeId)
          ? nodeId
          : `ERVO-${deviceAddress.replace(/:/g, '').slice(-4).toUpperCase()}`;

        const cleanName =
          nodeId &&
          !nodeId.startsWith('Android-') &&
          !nodeId.startsWith('Device') &&
          !nodeId.startsWith('NODE-') &&
          !this.isAppNodeId(nodeId)
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
          peer.role = this.isRelayNode(fixedDeviceId, cleanName) ? 'Relay Node' : peer.role;
          peer.isRelayCapable = true;
          peer.lastSeen = Date.now();
        } else {
          this.peers.set(deviceAddress, {
            id: deviceAddress,
            name: cleanName,
            nodeId: fixedDeviceId,
            role: this.isRelayNode(fixedDeviceId, cleanName) ? 'Relay Node' : 'Field Worker',
            rssi: -65,
            distanceMeters: 2.1,
            connectionState: 'CONNECTED',
            lastSeen: Date.now(),
            packetsReceived: 0,
            packetsSent: 0,
            isRelayCapable: true,
          });
        }
        this.updateCounts();
        storageService.recordMetricEvent({
          type: 'ACK',
          activeLinks: this.radioState.connectedCount,
        });

        // Send lightweight handshake ping fast after 80ms to confirm bidirectional link
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
          bleBridge.sendPacket(deviceAddress, handshakePacket, this.localConfig.nodeId, isSim).catch(() => { });
        }, 80);

        // Update direct physical link in local Dijkstra topology silently (no airwave spam)
        const myLocalId = this.localConfig.deviceId || this.localConfig.nodeId;
        const myLocalName = this.localConfig.displayName || this.localConfig.name;
        routingService.updateLocalDirectNeighbors(myLocalId, myLocalName, Array.from(this.peers.values()));

        // Fast opportunistic DTN Flush after 250ms
        setTimeout(() => {
          const connectedPeers = Array.from(this.peers.values()).filter(
            (p) => p.connectionState === 'CONNECTED'
          );
          outboxService
            .flush(connectedPeers, this.localConfig.nodeId, isSim)
            .then((flushed) => {
              if (flushed > 0) this.notifyState();
            });
        }, 250);

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

      onMessageReceived: (packet: ResQNetPacket, _rawPayload: string) => {
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

      onLocationUpdated: (loc) => {
        locationService.updatePosition(loc);
      },

      onBluetoothStateChanged: (state) => {
        const wasEnabled = this.radioState.isEnabled;
        this.radioState.isEnabled = state.isEnabled;

        if (!state.isEnabled) {
          this.radioState.isAdvertising = false;
          this.radioState.isScanning = false;
          for (const peer of this.peers.values()) {
            peer.connectionState = 'DISCONNECTED';
          }
          this.updateCounts();
        } else if (!wasEnabled && state.isEnabled) {
          this.ensureAlwaysOn().catch(() => { });
        }
        this.notifyState();
      },
    };

    bleBridge.registerListeners(events);
  }

  private updateCounts() {
    const deduped = this.getDeduplicatedPeers();
    let connected = 0;
    for (const peer of deduped) {
      if (peer.connectionState === 'CONNECTED') connected++;
    }
    this.radioState.connectedCount = connected;
    this.radioState.discoveredCount = deduped.length;
  }

  private isSelf(senderId?: string, senderName?: string): boolean {
    if (!senderId && !senderName) return false;
    const myDeviceId = this.localConfig.deviceId?.trim().toUpperCase();
    const myNodeId = this.localConfig.nodeId?.trim().toUpperCase();
    const myDisplayName = this.localConfig.displayName?.trim().toLowerCase();
    const myName = this.localConfig.name?.trim().toLowerCase();

    const checkId = senderId?.trim().toUpperCase();
    const checkName = senderName?.trim().toLowerCase();

    if (checkId) {
      if (myDeviceId && checkId === myDeviceId) return true;
      if (myNodeId && checkId === myNodeId) return true;
      // Compare 4-char suffix (e.g. ERVO-A1B2 vs RESQ-A1B2)
      const cleanMyId = myDeviceId ? myDeviceId.replace('ERVO-', '').replace('RESQ-', '') : '';
      const cleanCheckId = checkId.replace('ERVO-', '').replace('RESQ-', '');
      if (cleanMyId && cleanCheckId && cleanMyId === cleanCheckId) return true;
    }
    if (checkName) {
      if (myDisplayName && checkName === myDisplayName) return true;
      if (myName && checkName === myName) return true;
    }
    if (senderId) {
      const checkIdAsName = senderId.trim().toLowerCase();
      if (myDisplayName && checkIdAsName === myDisplayName) return true;
      if (myName && checkIdAsName === myName) return true;
    }
    return false;
  }

  public getDeduplicatedPeers(): PeerNode[] {
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const list: PeerNode[] = [];
    const now = Date.now();

    for (const peer of this.peers.values()) {
      // 1. Filter out self completely
      if (this.isSelf(peer.nodeId, peer.name) || this.isSelf(peer.id)) {
        continue;
      }
      // 2. Strict App-Only: Only accept devices with ERVONET/RESQNET signature
      const peerId = (peer.nodeId || '').trim().toUpperCase();
      const peerName = (peer.name || '').trim().toLowerCase();
      if (!this.isAppNodeId(peerId)) {
        continue;
      }
      // 3. Drop stale discovered nodes not seen in the last 30s
      if (peer.connectionState === 'DISCOVERED' && peer.lastSeen && now - peer.lastSeen > 30000) {
        continue;
      }
      // 4. Drop stale disconnected nodes not seen in the last 15s
      if (peer.connectionState === 'DISCONNECTED' && peer.lastSeen && now - peer.lastSeen > 15000) {
        continue;
      }
      // 5. Strict Deduplication by both canonical Node ID and human username
      if (peerId && seenIds.has(peerId)) continue;
      if (peerName && !peerName.startsWith('user-') && !peerName.startsWith('ervo-') && seenNames.has(peerName)) continue;

      if (peerId) seenIds.add(peerId);
      if (peerName && !peerName.startsWith('user-') && !peerName.startsWith('ervo-')) seenNames.add(peerName);

      list.push(peer);
    }

    // Incorporate multi-hop reachable peers discovered via LSA / Dijkstra graph
    const myId = this.localConfig.deviceId || this.localConfig.nodeId;
    const multiHopPeers = routingService.getMultiHopPeers(myId, list);
    for (const mPeer of multiHopPeers) {
      const mId = mPeer.nodeId.trim().toUpperCase();
      const mName = mPeer.name.trim().toLowerCase();
      if (!seenIds.has(mId) && !seenNames.has(mName) && !this.isSelf(mId, mName)) {
        seenIds.add(mId);
        if (mName && !mName.startsWith('user-') && !mName.startsWith('ervo-')) seenNames.add(mName);
        list.push(mPeer);
      }
    }

    return list;
  }

  private startStalePeerPruner() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, peer] of this.peers.entries()) {
        // Drop self
        if (this.isSelf(peer.nodeId, peer.name) || this.isSelf(peer.id)) {
          this.peers.delete(key);
          changed = true;
          continue;
        }
        // Drop disconnected after 15s
        if (peer.connectionState === 'DISCONNECTED' && peer.lastSeen && now - peer.lastSeen > 15000) {
          this.peers.delete(key);
          changed = true;
          continue;
        }
        // Drop discovered after 30s
        if (peer.connectionState === 'DISCOVERED' && peer.lastSeen && now - peer.lastSeen > 30000) {
          this.peers.delete(key);
          changed = true;
          continue;
        }
      }
      if (changed) {
        this.updateCounts();
        this.notifyState();
      }
    }, 5000);
    this.pruneTimer?.unref?.();
  }

  public startLocationBeacon() {
    if (this.locationBeaconTimer) clearInterval(this.locationBeaconTimer);
    this.locationBeaconTimer = setInterval(async () => {
      try {
        const connectedPeers = this.getDeduplicatedPeers().filter(
          (p) => p.connectionState === 'CONNECTED'
        );
        if (connectedPeers.length === 0) return;

        const loc = locationService.getLastKnownLocation();
        if (!loc) return;

        const packet = createPacket({
          senderId: this.localConfig.deviceId || this.localConfig.nodeId,
          senderName: this.localConfig.displayName || this.localConfig.name,
          destinationId: 'BROADCAST',
          payload: 'BEACON:LOC',
          messageType: 'PING',
          priority: 'NORMAL',
          ttl: 2,
          location: {
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy,
          },
        });

        const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
        await bleBridge.broadcastPacket(
          packet,
          this.localConfig.nodeId,
          connectedPeers.length,
          isSim
        );
      } catch {
        // Silent catch for periodic beacon
      }
    }, 10000);
    this.locationBeaconTimer?.unref?.();
  }

  /**
   * Persistent keep-alive watchdog ensuring Advertising, Scanning, and Auto-Connect remain permanently active
   */
  public startKeepAliveWatchdog() {
    if (this.keepAliveWatchdogTimer) clearInterval(this.keepAliveWatchdogTimer);
    this.keepAliveWatchdogTimer = setInterval(async () => {
      // Safeguard: only run if Bluetooth hardware is active
      if (!this.radioState.isEnabled) return;
      const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';

      // 1. Keep Advertising ALWAYS ON
      if (
        !this.radioState.isAdvertising &&
        (this.localConfig.hasConfiguredUsername || this.localConfig.displayName)
      ) {
        try {
          await bleBridge.startAdvertising(
            this.localConfig.deviceId || this.localConfig.nodeId,
            this.localConfig.role,
            this.localConfig.displayName || this.localConfig.name,
            isSim
          );
          this.radioState.isAdvertising = true;
          this.notifyState();
        } catch {}
      }

      // 2. Keep Auto-Scan ALWAYS ON
      if (!this.radioState.isScanning) {
        try {
          await bleBridge.startAutoScan(this.radioState.autoConnect, isSim);
          this.radioState.isScanning = true;
          this.notifyState();
        } catch {}
      }

      // 3. Keep Auto-Connect ALWAYS ON
      if (this.radioState.autoConnect && !isSim) {
        const now = Date.now();
        for (const peer of this.peers.values()) {
          if (
            (peer.connectionState === 'DISCOVERED' || peer.connectionState === 'DISCONNECTED') &&
            peer.lastSeen &&
            now - peer.lastSeen < 60000 &&
            !this.isSelf(peer.nodeId, peer.name) &&
            !this.isSelf(peer.id)
          ) {
            this.connectToPeer(peer.id).catch(() => {});
          }
        }
      }
    }, 2000);
    this.keepAliveWatchdogTimer?.unref?.();
  }

  /**
   * Explicitly ensures Advertising, Scanning, and Auto-Connect are active
   */
  public async ensureAlwaysOn(): Promise<void> {
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    this.radioState.autoConnect = true;

    if (!this.radioState.isAdvertising && (this.localConfig.hasConfiguredUsername || this.localConfig.displayName)) {
      try {
        await bleBridge.startAdvertising(
          this.localConfig.deviceId || this.localConfig.nodeId,
          this.localConfig.role,
          this.localConfig.displayName || this.localConfig.name,
          isSim
        );
        this.radioState.isAdvertising = true;
      } catch {}
    }

    if (!this.radioState.isScanning) {
      try {
        await bleBridge.startAutoScan(true, isSim);
        this.radioState.isScanning = true;
      } catch {}
    }

    this.startKeepAliveWatchdog();
    this.notifyState();
  }

  private markProcessedMessageId(messageId: string) {
    if (this.processedMessageIds.size >= 1000) {
      const oldest = this.processedMessageIds.values().next().value;
      if (oldest) {
        this.processedMessageIds.delete(oldest);
      }
    }
    this.processedMessageIds.add(messageId);
  }

  private handleIncomingPacket(packet: ResQNetPacket) {
    // 1. Loopback / self-echo suppression:
    // Drop any packet that originated from ourselves immediately!
    if (this.isSelf(packet.senderId, packet.senderName)) {
      this.markProcessedMessageId(packet.messageId);
      return;
    }

    // 2. Duplicate detection & loop suppression
    if (this.processedMessageIds.has(packet.messageId)) {
      storageService.recordMetricEvent({ type: 'DUPLICATE' });
      return;
    }
    this.markProcessedMessageId(packet.messageId);

    // Update peer's connection status, username, live location, and SOS distress status
    let peerUpdated = false;
    let foundPeer: PeerNode | undefined;
    for (const peer of this.peers.values()) {
      if (
        peer.nodeId === packet.senderId ||
        peer.name === packet.senderId ||
        peer.id === packet.senderId ||
        (packet.senderName && peer.name === packet.senderName)
      ) {
        foundPeer = peer;
        break;
      }
    }

    const isDirectHop = (packet.hopCount || 0) === 0;
    if (foundPeer) {
      if (isDirectHop && foundPeer.connectionState !== 'CONNECTED') {
        foundPeer.connectionState = 'CONNECTED';
        peerUpdated = true;
      }
      foundPeer.lastSeen = Date.now();
      if (packet.senderName && foundPeer.name !== packet.senderName) {
        foundPeer.name = packet.senderName;
        peerUpdated = true;
      }
      if (packet.location) {
        foundPeer.lastKnownLocation = {
          latitude: packet.location.latitude,
          longitude: packet.location.longitude,
          accuracy: packet.location.accuracy,
          timestamp: packet.timestamp || Date.now(),
        };
        peerUpdated = true;
      }
      if (packet.priority === 'CRITICAL_SOS' || packet.messageType === 'SOS') {
        foundPeer.hasActiveSos = true;
        peerUpdated = true;
      }
    } else if (
      isDirectHop &&
      packet.senderId &&
      this.isAppNodeId(packet.senderId)
    ) {
      const cleanName =
        packet.senderName ||
        `User (${packet.senderId.replace('ERVO-', '').replace('RESQ-', '')})`;
      this.peers.set(packet.senderId, {
        id: packet.senderId,
        name: cleanName,
        nodeId: packet.senderId,
        role: this.isRelayNode(packet.senderId, cleanName) ? 'Relay Node' : 'Field Worker',
        rssi: -65,
        distanceMeters: 2.0,
        connectionState: 'CONNECTED',
        lastSeen: Date.now(),
        packetsReceived: 1,
        packetsSent: 0,
        isRelayCapable: true,
        lastKnownLocation: packet.location,
        hasActiveSos: packet.priority === 'CRITICAL_SOS',
      });
      peerUpdated = true;
    }

    if (peerUpdated) {
      this.updateCounts();
      this.notifyState();
    }

    // Protocol PING / NODE_BEACON (handshake & location beacons)
    if (packet.messageType === 'PING' || packet.messageType === 'NODE_BEACON') {
      if (packet.payload === 'BEACON:LOC' || packet.messageType === 'NODE_BEACON') {
        // Location telemetry packet - already stored in peer.lastKnownLocation above
        // Forward beacon across mesh if TTL permits so all nodes can plot the remote peer accurately
        if (packet.ttl > 1) {
          this.relayPacketAcrossMesh(packet).catch(() => { });
        }
        return;
      }
      if (
        packet.payload.startsWith('HANDSHAKE:') &&
        !packet.payload.startsWith('HANDSHAKE_REPLY:')
      ) {
        setTimeout(() => {
          const replyPacket = createPacket({
            senderId: this.localConfig.deviceId || this.localConfig.nodeId,
            senderName: this.localConfig.displayName || this.localConfig.name,
            destinationId: packet.senderId,
            payload: `HANDSHAKE_REPLY:${this.localConfig.displayName || this.localConfig.name
              }`,
            messageType: 'PING',
            ttl: 1,
          });
          this.routePacketToDestination(replyPacket).catch(() => {});
        }, 150);
      }
      return;
    }

    // Protocol NODE_STATUS (ESP32 relay battery, queue, peer health telemetry)
    if (
      packet.messageType === 'NODE_STATUS' ||
      (typeof packet.payload === 'string' && packet.payload.startsWith('{"type":"NODE_STATUS"'))
    ) {
      try {
        const status = JSON.parse(packet.payload);
        if (status && status.type === 'NODE_STATUS' && status.nodeId) {
          const telemetry: RelayNodeTelemetry = {
            nodeId: String(status.nodeId),
            name: String(status.name || packet.senderName || status.nodeId),
            bleClients: Number(status.bleClients || 0),
            espNowPeers: Number(status.espNowPeers || 0),
            queueSize: Number(status.queueSize || 0),
            relayed: Number(status.relayed || 0),
            dropped: Number(status.dropped || 0),
            batteryPct: Number(status.batteryPct ?? 100),
            sdReady: !!status.sdReady,
            mapServer: !!status.mapServer,
            freeHeap: Number(status.freeHeap || 0),
            uptimeSec: Number(status.uptimeSec || 0),
            lastUpdated: Date.now(),
          };
          this.relayTelemetry.set(telemetry.nodeId.toUpperCase(), telemetry);
          if (foundPeer) {
            foundPeer.batteryLevel = telemetry.batteryPct;
          }
          if (packet.ttl > 1) {
            this.relayPacketAcrossMesh(packet).catch(() => { });
          }
          this.notifyState();
        }
      } catch (e) {
        console.warn('Failed to parse NODE_STATUS payload:', e);
      }
      return;
    }

    // Protocol MAP_SERVER_CMD (ESP32 On-Demand PMTiles SoftAP status telemetry)
    if (
      packet.messageType === 'MAP_SERVER_CMD' ||
      (typeof packet.payload === 'string' && packet.payload.startsWith('{"type":"MAP_SERVER_STATUS"'))
    ) {
      try {
        const info = JSON.parse(packet.payload);
        if (info && info.type === 'MAP_SERVER_STATUS') {
          this.mapServerStatus = {
            relayNodeId: packet.senderId,
            active: !!info.active,
            ssid: String(info.ssid || 'ERVONET-MAP-HUB'),
            password: info.password ? String(info.password) : undefined,
            ip: String(info.ip || '192.168.4.1'),
            channel: Number(info.channel || 1),
            url: String(info.url || 'http://192.168.4.1/maps/region.pmtiles'),
            sizeBytes: Number(info.sizeBytes || 0),
            sdReady: !!info.sdReady,
            validPmTiles: !!info.validPmTiles,
            expiresInSec: Number(info.expiresInSec || 0),
            lastUpdated: Date.now(),
          };
          this.notifyState();
        }
      } catch (e) {
        console.warn('Failed to parse MAP_SERVER_STATUS payload:', e);
      }
      return;
    }

    // Protocol ROUTING / ROUTE_UPDATE (Link-State Advertisements for dynamic Dijkstra mesh graph)
    // NEVER allow internal network control or LSA packets to enter chat storage or user feeds
    if (
      packet.messageType === 'ROUTING' ||
      packet.messageType === 'ROUTE_UPDATE' ||
      packet.destinationId === '__ROUTING_CONTROL__' ||
      packet.destinationId === 'MESH_ROUTING' ||
      (typeof packet.payload === 'string' && (
        packet.payload.includes('"type":"LSA"') ||
        packet.payload.startsWith('{"type":"LSA"')
      ))
    ) {
      try {
        if (typeof packet.payload === 'string' && packet.payload.includes('"type":"LSA"')) {
          const lsa = JSON.parse(packet.payload);
          if (lsa && lsa.type === 'LSA') {
            const { updated, shouldRebroadcast } = routingService.processLsa(lsa);
            if (shouldRebroadcast && packet.ttl > 1) {
              this.relayPacketAcrossMesh(packet).catch(() => { });
            }
            if (updated) {
              this.updateCounts();
              this.notifyState();
            }
          }
        }
      } catch (e) {
        console.warn('Failed to parse routing LSA payload:', e);
      }
      return;
    }

    // Register active 1-hop link or learned multi-hop DSR route edges in topology graph
    const myId = (this.localConfig.deviceId || this.localConfig.nodeId).trim().toUpperCase();
    if (isDirectHop && packet.senderId) {
      routingService.addLink(
        packet.senderId,
        myId,
        foundPeer?.rssi || -65,
        packet.senderName,
        this.localConfig.displayName || this.localConfig.name
      );
    } else if (!isDirectHop && packet.route && packet.route.length >= 2) {
      for (let i = 0; i < packet.route.length - 1; i++) {
        routingService.addLink(
          packet.route[i],
          packet.route[i + 1],
          -65,
          i === 0 ? packet.senderName : undefined,
          i + 1 === packet.route.length - 1 ? this.localConfig.displayName || this.localConfig.name : undefined
        );
      }
    }

    const isForMe = this.isSelf(packet.destinationId);
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
        }
      } else if (packet.ttl > 1) {
        // Relay ACK across mesh back to original sender
        this.relayPacketAcrossMesh(packet).catch(() => {});
      }
      return;
    }

    // 3. Message is for this node or a broadcast:
    if (isForMe || isBroadcast) {
      const decodedPayload = packet.encrypted
        ? decryptPayloadHex(packet.payload, packet.messageId)
        : packet.payload;
      const record: MessageRecord = {
        id: packet.messageId,
        packet: {
          ...packet,
          payload: decodedPayload,
          hopCount: packet.hopCount,
        },
        direction: 'INCOMING',
        status: 'DELIVERED',
        createdAt: Date.now(),
        deliveredAt: Date.now(),
      };

      storageService.addMessage(record);
      storageService.recordMetricEvent({ type: 'RECEIVED' });

      // Automatically send ACK back to sender for point-to-point messages
      if (isForMe) {
        const ack = createAckPacket(
          packet,
          this.localConfig.deviceId || this.localConfig.nodeId
        );
        ack.senderName = this.localConfig.displayName || this.localConfig.name;
        this.routePacketToDestination(ack).catch((e) => {
          console.warn('Auto-ACK dispatch notice:', e?.message || e);
        });
      }
    }

    // 4. BLE Mesh Multi-Hop Forwarding:
    // If packet is a broadcast or destined for another node, forward to peers if TTL allows
    if ((isBroadcast || !isForMe) && packet.ttl > 1) {
      this.relayPacketAcrossMesh(packet).catch((e) => {
        console.warn('Mesh forward notice:', e?.message || e);
      });
    }

    this.notifyState();
  }

  private async forwardPacketToPeer(
    targetNodeOrMac: string,
    packet: ResQNetPacket,
    isSim: boolean
  ): Promise<boolean> {
    const cleanTarget = targetNodeOrMac.trim().toUpperCase();
    const myId = (this.localConfig.deviceId || this.localConfig.nodeId).trim().toUpperCase();

    // 1. Check if direct peer is in connected list by nodeId, MAC, or name
    let directPeer = Array.from(this.peers.values()).find(
      (p) =>
        p.connectionState === 'CONNECTED' &&
        ((p.nodeId && p.nodeId.trim().toUpperCase() === cleanTarget) ||
          (p.id && p.id.trim().toUpperCase() === cleanTarget) ||
          (p.name && p.name.trim().toUpperCase() === cleanTarget) ||
          (p.nodeId &&
            p.nodeId.replace('ERVO-', '').replace('RESQ-', '') ===
              cleanTarget.replace('ERVO-', '').replace('RESQ-', '')))
    );

    if (directPeer) {
      try {
        await bleBridge.sendPacket(directPeer.id, packet, myId, isSim);
        return true;
      } catch {
        try {
          await bleBridge.sendPacket(directPeer.nodeId, packet, myId, isSim);
          return true;
        } catch {}
      }
    }

    // 2. Direct attempt using target address or Node ID string
    try {
      await bleBridge.sendPacket(cleanTarget, packet, myId, isSim);
      return true;
    } catch {
      return false;
    }
  }

  private async relayPacketAcrossMesh(packet: ResQNetPacket): Promise<boolean> {
    if (packet.ttl <= 1) {
      storageService.recordMetricEvent({ type: 'EXPIRED' });
      return false;
    }

    // Never relay packets that originated from ourselves
    if (this.isSelf(packet.senderId, packet.senderName)) {
      return false;
    }

    const myNodeId = (this.localConfig.deviceId || this.localConfig.nodeId).trim().toUpperCase();
    const visited = new Set<string>((packet.visitedNodes || []).map((v) => v.trim().toUpperCase()));
    visited.add(myNodeId);
    if (packet.senderId) visited.add(packet.senderId.trim().toUpperCase());

    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    const isBroadcast =
      packet.destinationId === 'BROADCAST' ||
      packet.destinationId === '#all' ||
      packet.destinationId.startsWith('#');

    const relayedPacket: ResQNetPacket = {
      ...packet,
      ttl: packet.ttl - 1,
      hopCount: (packet.hopCount || 0) + 1,
      visitedNodes: Array.from(visited),
    };

    storageService.recordMetricEvent({ type: 'RELAY' });

    // --- ALGORITHM 1: DIJKSTRA SOURCE ROUTING FOR POINT-TO-POINT ---
    if (!isBroadcast && packet.route && packet.route.length >= 2) {
      const nextHopInfo = routingService.getNextHopForRoute(packet, myNodeId);
      if (nextHopInfo) {
        relayedPacket.routeIndex = nextHopInfo.nextRouteIndex;
        const targetNextHop = nextHopInfo.nextHop;

        const sent = await this.forwardPacketToPeer(targetNextHop, relayedPacket, isSim);
        if (sent) return true;
        // If designated next hop is currently unreachable, fall through to dynamic re-route
      }
    }

    // --- ALGORITHM 2: DYNAMIC SELF-HEALING DIJKSTRA RE-ROUTING ---
    // If route was broken or packet didn't have route yet, re-compute Dijkstra from this node
    if (!isBroadcast) {
      const dynamicRoute = routingService.findShortestPath(myNodeId, packet.destinationId);
      if (dynamicRoute && dynamicRoute.path.length >= 2) {
        relayedPacket.route = dynamicRoute.path;
        relayedPacket.routeIndex = 1;
        relayedPacket.routingAlgo = 'DIJKSTRA';

        const sent = await this.forwardPacketToPeer(dynamicRoute.nextHop, relayedPacket, isSim);
        if (sent) return true;
      }
    }

    // --- ALGORITHM 3: CONTROLLED MANAGED MESH FLOODING (FALLBACK / BROADCAST) ---
    // Forward to all active connected neighbors excluding visited nodes and original sender
    let sentCount = 0;
    for (const peer of this.peers.values()) {
      if (peer.connectionState === 'CONNECTED') {
        const peerNodeId = (peer.nodeId || peer.id).trim().toUpperCase();
        const peerRawId = (peer.id || '').trim().toUpperCase();

        if (
          !visited.has(peerNodeId) &&
          !visited.has(peerRawId) &&
          !this.isSelf(peerNodeId, peer.name) &&
          peerNodeId !== packet.senderId.trim().toUpperCase()
        ) {
          try {
            await bleBridge.sendPacket(
              peer.id,
              relayedPacket,
              this.localConfig.nodeId,
              isSim
            );
            sentCount++;
          } catch (e) {
            console.warn('Managed relay forward failed to peer:', peer.nodeId, e);
          }
        }
      }
    }
    return sentCount > 0;
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
      return res.deliveredCount > 0 || isSim;
    }

    const myId = (this.localConfig.deviceId || this.localConfig.nodeId).trim().toUpperCase();
    const destId = packet.destinationId.trim().toUpperCase();

    // 1. Direct 1-hop connected peer lookup
    let directPeer: PeerNode | undefined;
    for (const p of this.peers.values()) {
      if (
        (p.nodeId === packet.destinationId ||
          p.id === packet.destinationId ||
          p.name === packet.destinationId ||
          p.nodeId.replace('ERVO-', '').replace('RESQ-', '') === packet.destinationId.replace('ERVO-', '').replace('RESQ-', '')) &&
        p.connectionState === 'CONNECTED'
      ) {
        directPeer = p;
        break;
      }
    }

    // Direct peer connected - transmit directly
    if (directPeer) {
      try {
        await bleBridge.sendPacket(
          directPeer.id,
          packet,
          this.localConfig.nodeId,
          isSim
        );
        return true;
      } catch {
        console.warn(`Direct transmission to ${directPeer.id} failed, trying by nodeId ${directPeer.nodeId}...`);
        try {
          await bleBridge.sendPacket(
            directPeer.nodeId,
            packet,
            this.localConfig.nodeId,
            isSim
          );
          return true;
        } catch {}
      }
    }

    // 2. Multi-hop destination: Run Dijkstra Shortest Path Algorithm!
    const route = routingService.findShortestPath(myId, destId);
    if (route && route.path.length >= 2) {
      packet.route = route.path;
      packet.routeIndex = 0;
      packet.routingAlgo = 'DIJKSTRA';
      packet.visitedNodes = [myId];

      const sent = await this.forwardPacketToPeer(route.nextHop, packet, isSim);
      if (sent) return true;
    }

    // 3. Fallback: Check if peer is found in known peers list
    const fallbackPeer = Array.from(this.peers.values()).find(
      (p) =>
        p.nodeId === packet.destinationId ||
        p.id === packet.destinationId ||
        p.name === packet.destinationId ||
        p.nodeId.replace('ERVO-', '').replace('RESQ-', '') === packet.destinationId.replace('ERVO-', '').replace('RESQ-', '')
    );
    if (fallbackPeer && !fallbackPeer.isMultiHop) {
      try {
        await bleBridge.sendPacket(
          fallbackPeer.id,
          packet,
          this.localConfig.nodeId,
          isSim
        );
        return true;
      } catch {
        try {
          await bleBridge.sendPacket(
            fallbackPeer.nodeId,
            packet,
            this.localConfig.nodeId,
            isSim
          );
          return true;
        } catch {}
      }
    }

    // 4. Fallback: Controlled Managed Multi-Hop Flooding across all connected peers
    let sentCount = 0;
    packet.visitedNodes = [myId];
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
        } catch {
          console.warn('Mesh forward failed to peer:', peer.id);
        }
      }
    }
    return sentCount > 0;
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

  public getRelayTelemetry(): RelayNodeTelemetry[] {
    return Array.from(this.relayTelemetry.values());
  }

  public getMapServerStatus(): MapServerStatus | null {
    return this.mapServerStatus;
  }

  public async requestRelayMapServer(
    action: 'START' | 'STOP' | 'STATUS',
    targetRelayId?: string
  ): Promise<boolean> {
    const relays = this.getDeduplicatedPeers().filter(
      (p) => p.connectionState === 'CONNECTED' && this.isRelayNode(p.nodeId, p.name)
    );
    const chosen =
      targetRelayId ||
      relays[0]?.id ||
      relays[0]?.nodeId;
    if (!chosen) {
      return false;
    }

    const packet = createPacket({
      senderId: this.localConfig.deviceId || this.localConfig.nodeId,
      senderName: this.localConfig.displayName || this.localConfig.name,
      destinationId: relays.find((r) => r.id === chosen || r.nodeId === chosen)?.nodeId || chosen,
      payload: `MAP_SERVER_CMD:${action}`,
      messageType: 'MAP_SERVER_CMD',
      priority: 'NORMAL',
      ttl: 1,
    });
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    try {
      await bleBridge.sendPacket(chosen, packet, this.localConfig.nodeId, isSim);
      return true;
    } catch {
      return false;
    }
  }

  public getStateSnapshot() {
    return {
      radioState: { ...this.radioState },
      peers: this.getDeduplicatedPeers(),
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
    let actualMac = deviceAddress;
    let peer = this.peers.get(deviceAddress);
    if (!peer) {
      for (const [key, p] of this.peers.entries()) {
        if (
          p.nodeId === deviceAddress ||
          p.name === deviceAddress ||
          p.id === deviceAddress
        ) {
          actualMac = key;
          peer = p;
          break;
        }
      }
    }
    if (peer) {
      peer.connectionState = 'CONNECTING';
      this.notifyState();
    }
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    return await bleBridge.connectNode(actualMac, isSim);
  }

  public async disconnectPeer(deviceAddress: string): Promise<boolean> {
    let actualMac = deviceAddress;
    for (const [key, p] of this.peers.entries()) {
      if (
        p.nodeId === deviceAddress ||
        p.name === deviceAddress ||
        p.id === deviceAddress
      ) {
        actualMac = key;
        break;
      }
    }
    const isSim = this.radioState.operatingMode === 'SIMULATION_TESTBED';
    return await bleBridge.disconnectNode(actualMac, isSim);
  }

  public async transmitMessage(params: {
    targetId: string; // 'BROADCAST' or deviceAddress / nodeId / channel
    payload: string;
    priority?: MessagePriority;
    messageType?: MessageType;
    ttl?: number;
    location?: {
      latitude: number;
      longitude: number;
      accuracy?: number;
    };
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
      ttl: params.ttl || 10,
      messageType: params.messageType || (params.priority === 'CRITICAL_SOS' ? 'ALERT' : 'TEXT'),
      location: params.location,
    });

    // Mark as processed immediately so incoming radio reflections are suppressed
    this.markProcessedMessageId(packet.messageId);

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

    // On-demand connection if target peer is directly discovered but not yet connected
    if (!isBroadcast && targetAddress && targetPeer && !targetPeer.isMultiHop && targetPeer.connectionState !== 'CONNECTED' && !isSim) {
      try {
        console.log(`Connecting to peer ${targetAddress} before transmitting...`);
        await this.connectToPeer(targetAddress);
        // Fast on-demand connection: wait up to 1000ms with tight 40ms checks
        for (let i = 0; i < 25; i++) {
          await new Promise<void>((res) => setTimeout(() => res(), 40));
          const updated = this.peers.get(targetAddress) || Array.from(this.peers.values()).find(p => p.nodeId === destNodeId);
          if (updated?.connectionState === 'CONNECTED') break;
        }
      } catch (e) {
        console.warn('On-demand connection attempt failed:', e);
      }
    }

    // Broadcast on-demand: if 0 connected, trigger fast connection to any discovered peers
    if (isBroadcast && this.radioState.connectedCount === 0 && !isSim) {
      const discovered = Array.from(this.peers.values()).filter((p) => p.connectionState === 'DISCOVERED');
      for (const p of discovered) {
        this.connectToPeer(p.id).catch(() => { });
      }
      if (discovered.length > 0) {
        for (let i = 0; i < 15; i++) {
          await new Promise<void>((res) => setTimeout(() => res(), 50));
          if (this.radioState.connectedCount > 0) break;
        }
      }
    }

    // Try transmission immediately with 1 retry on transient link glitch
    try {
      let delivered = false;
      try {
        delivered = await this.routePacketToDestination(packet);
      } catch {
        await new Promise<void>((r) => setTimeout(() => r(), 250));
        delivered = await this.routePacketToDestination(packet);
      }

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

    // On-demand connection if target peer is directly discovered and not connected
    let targetAddress = record.targetAddress;
    if (!isBroadcast) {
      const targetPeer = Array.from(this.peers.values()).find(
        (p) =>
          p.id === packet.destinationId ||
          p.nodeId === packet.destinationId ||
          p.name === packet.destinationId ||
          (targetAddress && p.id === targetAddress)
      );
      if (targetPeer && !targetPeer.isMultiHop && targetPeer.connectionState !== 'CONNECTED' && !isSim) {
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
    } catch {
      outboxService.enqueue(packet, targetAddress);
      storageService.updateMessageStatus(messageId, 'QUEUED');
      storageService.recordMetricEvent({ type: 'FAIL' });
      this.notifyState();
      return false;
    }
  }

  /**
   * Share an offline map sector definition over the BLE mesh to peers or broadcast
   */
  public async shareMapSector(params: {
    targetId: string;
    name: string;
    bounds: [number, number, number, number];
    minZoom?: number;
    maxZoom?: number;
    style?: string;
    center?: [number, number];
  }): Promise<boolean> {
    const sectorData = {
      type: 'MAP_SECTOR' as const,
      name: params.name,
      bounds: params.bounds,
      minZoom: params.minZoom || 12,
      maxZoom: params.maxZoom || 15,
      style: params.style || 'liberty',
      center: params.center || [
        (params.bounds[0] + params.bounds[2]) / 2,
        (params.bounds[1] + params.bounds[3]) / 2,
      ],
      timestamp: Date.now(),
    };

    return await this.transmitMessage({
      targetId: params.targetId,
      payload: JSON.stringify(sectorData),
      messageType: 'MAP_DATA',
      priority: 'NORMAL',
    });
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
    this.relayTelemetry.clear();
    this.mapServerStatus = null;
    this.processedMessageIds.clear();
    outboxService.clear();
    storageService.wipeAllData();
    this.updateCounts();
    this.notifyState();
  }
}

export const bleService = new BleService();

