import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';
import { PeerNode, NodeRole } from '../types/ble';
import { ResQNetPacket } from '../types/message';
import { estimateDistanceMeters } from '../utils/distance';
import { parsePacket, createAckPacket, serializePacket } from '../protocol/packetSchema';
import { chunkPacket, defaultChunkReassembler } from '../protocol/chunker';

const { ResQNetBle } = NativeModules;

export interface BleBridgeEvents {
  onNodeDiscovered: (node: PeerNode) => void;
  onNodeConnected: (deviceAddress: string, nodeId: string) => void;
  onNodeDisconnected: (deviceAddress: string) => void;
  onMessageReceived: (packet: ResQNetPacket, rawPayload: string) => void;
  onMessageDelivered: (targetAddress: string, latencyMs: number) => void;
  onScanStatusChanged: (isScanning: boolean) => void;
  onAdvertisingStatusChanged: (isAdvertising: boolean) => void;
  onLocationUpdated?: (loc: { latitude: number; longitude: number; accuracy?: number; timestamp?: number }) => void;
  onBluetoothStateChanged?: (state: { isEnabled: boolean; state?: number }) => void;
}

class NativeBleBridge {
  private eventEmitter: NativeEventEmitter | null = null;
  private isNativeAvailable: boolean = false;
  private simListeners: BleBridgeEvents | null = null;
  private simTimer: any = null;
  private simRssiTimer: any = null;
  private isSimScanning: boolean = false;
  private isSimAdvertising: boolean = false;
  private simulatedPeers: Map<string, PeerNode> = new Map();

  constructor() {
    this.isNativeAvailable = Platform.OS === 'android' && !!ResQNetBle;
    if (this.isNativeAvailable) {
      this.eventEmitter = new NativeEventEmitter(ResQNetBle);
    }
    this.initializeSimulatedPeers();
  }

  private initializeSimulatedPeers() {
    this.simulatedPeers.clear();
    // Simulated testbed multi-hop neighbor: Node B (Bravo)
    this.simulatedPeers.set('AA:BB:CC:11:22:01', {
      id: 'AA:BB:CC:11:22:01',
      name: 'Bravo Node',
      nodeId: 'ERVO-BBBB',
      role: 'Relay Node',
      rssi: -62,
      distanceMeters: 3.0,
      connectionState: 'DISCOVERED',
      lastSeen: Date.now(),
      packetsReceived: 0,
      packetsSent: 0,
      isRelayCapable: true,
    });
  }

  public hasNativeBleSupport(): boolean {
    return this.isNativeAvailable;
  }

  public async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;

    try {
      if (Platform.Version >= 33) {
        // Android 13+ requires notification permission for foreground mesh service
        try {
          await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
        } catch (e) {
          console.warn('Notification permission request notice:', e);
        }
      }

      if (Platform.Version >= 31) {
        const statuses = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        const scanOk =
          statuses[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const connectOk =
          statuses[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const advOk =
          statuses[PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE] ===
          PermissionsAndroid.RESULTS.GRANTED;

        return scanOk && connectOk && advOk;
      } else {
        const statuses = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);
        return (
          statuses[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
          PermissionsAndroid.RESULTS.GRANTED
        );
      }
    } catch (e) {
      console.warn('Failed to request Bluetooth permissions:', e);
      return false;
    }
  }

  public registerListeners(callbacks: BleBridgeEvents) {
    this.simListeners = callbacks;

    if (this.isNativeAvailable && this.eventEmitter) {
      this.eventEmitter.addListener('onNodeDiscovered', (data: any) => {
        const distance = estimateDistanceMeters(data.rssi, data.txPower || -59);
        const nodeId = data.nodeId || `NODE-${data.id.slice(-4)}`;
        const name = data.name || data.nodeId || 'Unknown Peer';
        const isEspRelay =
          /^ERVO-ES/i.test(nodeId) ||
          /^RESQ-ES/i.test(nodeId) ||
          /ESP32|RELAY/i.test(name);
        const node: PeerNode = {
          id: data.id,
          name,
          nodeId,
          role: isEspRelay ? 'Relay Node' : 'Field Worker',
          rssi: data.rssi,
          distanceMeters: distance,
          connectionState: 'DISCOVERED',
          lastSeen: Date.now(),
          packetsReceived: 0,
          packetsSent: 0,
          isRelayCapable: true,
        };
        callbacks.onNodeDiscovered(node);
      });

      this.eventEmitter.addListener('onNodeConnected', (data: any) => {
        callbacks.onNodeConnected(data.address, data.nodeId || 'Unknown');
      });

      this.eventEmitter.addListener('onNodeDisconnected', (data: any) => {
        callbacks.onNodeDisconnected(data.address);
      });

      this.eventEmitter.addListener('onMessageReceived', (data: any) => {
        // Feed into chunk reassembler to support messages of any length over BLE
        const fullPayload = defaultChunkReassembler.ingest(data.payload);
        if (fullPayload) {
          const parsed = parsePacket(fullPayload);
          if (parsed) {
            callbacks.onMessageReceived(parsed, fullPayload);
          }
        }
      });

      this.eventEmitter.addListener('onMessageDelivered', (data: any) => {
        callbacks.onMessageDelivered(data.targetAddress, data.latencyMs);
      });

      this.eventEmitter.addListener('onScanStatusChanged', (data: any) => {
        callbacks.onScanStatusChanged(data.isScanning);
      });

      this.eventEmitter.addListener('onAdvertisingStatusChanged', (data: any) => {
        callbacks.onAdvertisingStatusChanged(data.isAdvertising);
      });

      this.eventEmitter.addListener('onLocationUpdated', (data: any) => {
        if (data && callbacks.onLocationUpdated) {
          callbacks.onLocationUpdated({
            latitude: data.latitude,
            longitude: data.longitude,
            accuracy: data.accuracy,
            timestamp: data.timestamp,
          });
        }
      });

      this.eventEmitter.addListener('onBluetoothStateChanged', (data: any) => {
        if (data && callbacks.onBluetoothStateChanged) {
          callbacks.onBluetoothStateChanged({
            isEnabled: !!data.isEnabled,
            state: data.state,
          });
        }
      });
    }
  }

  public async getBluetoothStatus(): Promise<{
    isSupported: boolean;
    isEnabled: boolean;
    hasPermissions: boolean;
    isAdvertising: boolean;
    isScanning: boolean;
    fixedDeviceId?: string;
  }> {
    if (this.isNativeAvailable) {
      try {
        return await ResQNetBle.getBluetoothStatus();
      } catch (e) {
        console.warn('Native getBluetoothStatus failed:', e);
      }
    }
    return {
      isSupported: true,
      isEnabled: true,
      hasPermissions: true,
      isAdvertising: this.isSimAdvertising,
      isScanning: this.isSimScanning,
      fixedDeviceId: 'ERVO-LOCAL',
    };
  }

  public async getFixedDeviceId(): Promise<string> {
    if (this.isNativeAvailable && ResQNetBle.getFixedDeviceId) {
      try {
        return await ResQNetBle.getFixedDeviceId();
      } catch (e) {
        console.warn('Native getFixedDeviceId failed:', e);
      }
    }
    return 'ERVO-LOCAL';
  }

  public async getSavedUsername(): Promise<string> {
    if (this.isNativeAvailable && ResQNetBle.getSavedUsername) {
      try {
        return await ResQNetBle.getSavedUsername();
      } catch (e) {
        console.warn('Native getSavedUsername failed:', e);
      }
    }
    return '';
  }

  public async saveUsername(username: string): Promise<boolean> {
    if (this.isNativeAvailable && ResQNetBle.saveUsername) {
      try {
        return await ResQNetBle.saveUsername(username);
      } catch (e) {
        console.warn('Native saveUsername failed:', e);
      }
    }
    return true;
  }

  public async enableBluetooth(): Promise<boolean> {
    if (this.isNativeAvailable) {
      try {
        return await ResQNetBle.requestEnableBluetooth();
      } catch (e) {
        console.warn('requestEnableBluetooth failed:', e);
      }
    }
    return true;
  }

  public async openBluetoothSettings(): Promise<boolean> {
    if (this.isNativeAvailable && ResQNetBle?.openBluetoothSettings) {
      try {
        return await ResQNetBle.openBluetoothSettings();
      } catch (e) {
        console.warn('openBluetoothSettings failed:', e);
      }
    }
    return false;
  }

  public async getDeviceLocation(): Promise<{ latitude: number; longitude: number; accuracy?: number; timestamp?: number } | null> {
    if (this.isNativeAvailable && ResQNetBle?.getDeviceLocation) {
      try {
        const loc = await ResQNetBle.getDeviceLocation();
        if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
          return {
            latitude: loc.latitude,
            longitude: loc.longitude,
            accuracy: loc.accuracy,
            timestamp: loc.timestamp,
          };
        }
      } catch (e) {
        console.warn('Native getDeviceLocation failed:', e);
      }
    }
    return null;
  }

  public async startLocationUpdates(): Promise<boolean> {
    if (this.isNativeAvailable && ResQNetBle?.startLocationUpdates) {
      try {
        return await ResQNetBle.startLocationUpdates();
      } catch (e) {
        console.warn('Native startLocationUpdates failed:', e);
      }
    }
    return false;
  }

  public async startAdvertising(
    nodeId: string,
    nodeRole: NodeRole,
    displayName?: string,
    forceSimulation: boolean = false
  ): Promise<boolean> {
    if (this.isNativeAvailable && !forceSimulation) {
      try {
        await this.requestPermissions();
        return await ResQNetBle.startAdvertising(nodeId, nodeRole, displayName || nodeId);
      } catch (e) {
        console.warn('Native startAdvertising failed, using simulation:', e);
      }
    }

    this.isSimAdvertising = true;
    this.simListeners?.onAdvertisingStatusChanged(true);
    return true;
  }

  public async stopAdvertising(forceSimulation: boolean = false): Promise<boolean> {
    if (this.isNativeAvailable && !forceSimulation) {
      try {
        return await ResQNetBle.stopAdvertising();
      } catch (e) {
        console.warn('Native stopAdvertising failed:', e);
      }
    }

    this.isSimAdvertising = false;
    this.simListeners?.onAdvertisingStatusChanged(false);
    return true;
  }

  public async startAutoScan(
    autoConnect: boolean = true,
    forceSimulation: boolean = false
  ): Promise<boolean> {
    if (this.isNativeAvailable && !forceSimulation) {
      try {
        await this.requestPermissions();
        return await ResQNetBle.startScanning(autoConnect);
      } catch (e) {
        console.warn('Native startScanning failed, using simulation:', e);
      }
    }

    this.isSimScanning = true;
    this.simListeners?.onScanStatusChanged(true);

    // Simulate discovering nearby nodes in sequence
    let count = 0;
    const peers = Array.from(this.simulatedPeers.values());

    const emitNextPeer = () => {
      if (!this.isSimScanning) return;
      if (count < peers.length) {
        const peer = peers[count];
        this.simListeners?.onNodeDiscovered({ ...peer, lastSeen: Date.now() });

        if (autoConnect) {
          setTimeout(() => {
            if (this.isSimScanning) {
              peer.connectionState = 'CONNECTED';
              this.simListeners?.onNodeConnected(peer.id, peer.nodeId);

              // In simulation mode, simulate receiving multi-hop LSA network: B -> C -> D -> E -> F
              setTimeout(() => {
                if (this.isSimScanning && this.simListeners) {
                  const bLsa = {
                    type: 'LSA',
                    originNodeId: 'ERVO-BBBB',
                    originName: 'Bravo Node',
                    sequenceNumber: 1,
                    neighbors: [
                      { nodeId: 'ERVO-CCCC', name: 'Charlie Node', rssi: -68 },
                    ],
                    timestamp: Date.now(),
                  };
                  const cLsa = {
                    type: 'LSA',
                    originNodeId: 'ERVO-CCCC',
                    originName: 'Charlie Node',
                    sequenceNumber: 1,
                    neighbors: [
                      { nodeId: 'ERVO-BBBB', name: 'Bravo Node', rssi: -68 },
                      { nodeId: 'ERVO-DDDD', name: 'Delta Node', rssi: -65 },
                    ],
                    timestamp: Date.now(),
                  };
                  const dLsa = {
                    type: 'LSA',
                    originNodeId: 'ERVO-DDDD',
                    originName: 'Delta Node',
                    sequenceNumber: 1,
                    neighbors: [
                      { nodeId: 'ERVO-CCCC', name: 'Charlie Node', rssi: -65 },
                      { nodeId: 'ERVO-EEEE', name: 'Echo Node', rssi: -70 },
                    ],
                    timestamp: Date.now(),
                  };
                  const eLsa = {
                    type: 'LSA',
                    originNodeId: 'ERVO-EEEE',
                    originName: 'Echo Node',
                    sequenceNumber: 1,
                    neighbors: [
                      { nodeId: 'ERVO-DDDD', name: 'Delta Node', rssi: -70 },
                      { nodeId: 'ERVO-FFFF', name: 'Foxtrot Node', rssi: -64 },
                    ],
                    timestamp: Date.now(),
                  };

                  for (const l of [bLsa, cLsa, dLsa, eLsa]) {
                    const p: ResQNetPacket = {
                      messageId: `sim-lsa-${l.originNodeId}-${Date.now()}`,
                      senderId: l.originNodeId,
                      senderName: l.originName,
                      destinationId: '__ROUTING_CONTROL__',
                      timestamp: Date.now(),
                      ttl: 8,
                      priority: 'NORMAL',
                      messageType: 'ROUTING',
                      payload: JSON.stringify(l),
                      hopCount: 1,
                      checksum: 'SIMLSA',
                    };
                    this.simListeners?.onMessageReceived(p, JSON.stringify(p));
                  }
                }
              }, 800);
            }
          }, 800);
        }
        count++;
        this.simTimer = setTimeout(emitNextPeer, 1200);
        this.simTimer?.unref?.();
      }
    };

    this.simTimer = setTimeout(emitNextPeer, 500);
    this.simTimer?.unref?.();

    // Fluctuate RSSI slightly to simulate real RF path loss / worker movements
    if (!this.simRssiTimer) {
      this.simRssiTimer = setInterval(() => {
        if (this.isSimScanning) {
          for (const peer of this.simulatedPeers.values()) {
            const jitter = Math.floor(Math.random() * 5) - 2;
            peer.rssi = Math.max(-92, Math.min(-50, peer.rssi + jitter));
            peer.distanceMeters = estimateDistanceMeters(peer.rssi);
            peer.lastSeen = Date.now();
            this.simListeners?.onNodeDiscovered({ ...peer });
          }
        }
      }, 4000);
      this.simRssiTimer?.unref?.();
    }

    return true;
  }

  public async stopAutoScan(forceSimulation: boolean = false): Promise<boolean> {
    if (this.isNativeAvailable && !forceSimulation) {
      try {
        return await ResQNetBle.stopScanning();
      } catch (e) {
        console.warn('Native stopScanning failed:', e);
      }
    }

    this.isSimScanning = false;
    if (this.simTimer) clearTimeout(this.simTimer);
    this.simListeners?.onScanStatusChanged(false);
    return true;
  }

  public async connectNode(
    deviceAddress: string,
    forceSimulation: boolean = false
  ): Promise<boolean> {
    if (this.isNativeAvailable && !forceSimulation) {
      try {
        return await ResQNetBle.connect(deviceAddress);
      } catch (e) {
        console.warn('Native connect failed:', e);
      }
    }

    const peer = this.simulatedPeers.get(deviceAddress);
    if (peer) {
      peer.connectionState = 'CONNECTING';
      setTimeout(() => {
        peer.connectionState = 'CONNECTED';
        this.simListeners?.onNodeConnected(deviceAddress, peer.nodeId);
      }, 600);
      return true;
    }
    return false;
  }

  public async disconnectNode(
    deviceAddress: string,
    forceSimulation: boolean = false
  ): Promise<boolean> {
    if (this.isNativeAvailable && !forceSimulation) {
      try {
        return await ResQNetBle.disconnect(deviceAddress);
      } catch (e) {
        console.warn('Native disconnect failed:', e);
      }
    }

    const peer = this.simulatedPeers.get(deviceAddress);
    if (peer) {
      peer.connectionState = 'DISCONNECTED';
      this.simListeners?.onNodeDisconnected(deviceAddress);
      return true;
    }
    return false;
  }

  public async sendPacket(
    targetAddress: string,
    packet: ResQNetPacket,
    localNodeId: string,
    forceSimulation: boolean = false
  ): Promise<boolean> {
    const rawJson = serializePacket(packet);

    if (this.isNativeAvailable && !forceSimulation) {
      try {
        const chunks = chunkPacket(rawJson, packet.messageId);
        for (let i = 0; i < chunks.length; i++) {
          await ResQNetBle.sendMessage(targetAddress, chunks[i]);
          if (chunks.length > 1 && i < chunks.length - 1) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 12));
          }
        }
        return true;
      } catch (e) {
        console.warn('Native sendMessage failed:', e);
        throw e;
      }
    }

    // In simulation mode: simulate over-the-air round-trip latency & ACK response
    const hops = packet.route && packet.route.length >= 2 ? packet.route.length - 1 : (packet.hopCount || 1);
    const latency = hops > 1 ? hops * 50 : Math.floor(Math.random() * 30) + 35;
    setTimeout(() => {
      this.simListeners?.onMessageDelivered(targetAddress, latency);

      // Destination peer receives packet and returns ACK back across the mesh
      if (packet.messageType !== 'ACK' && packet.messageType !== 'ROUTING') {
        const destId = packet.destinationId;
        const responderId = destId !== 'BROADCAST' && destId ? destId : 'ERVO-FFFF';
        const ackPacket = createAckPacket(
          { ...packet, hopCount: hops },
          responderId
        );
        setTimeout(() => {
          this.simListeners?.onMessageReceived(ackPacket, serializePacket(ackPacket));
        }, latency);
      }
    }, latency);

    return true;
  }

  public async broadcastPacket(
    packet: ResQNetPacket,
    localNodeId: string,
    connectedCount: number,
    forceSimulation: boolean = false
  ): Promise<{ deliveredCount: number; totalNodes: number }> {
    const rawJson = serializePacket(packet);

    if (this.isNativeAvailable && !forceSimulation) {
      try {
        const chunks = chunkPacket(rawJson, packet.messageId);
        let result = { deliveredCount: 0, totalNodes: 0 };
        for (let i = 0; i < chunks.length; i++) {
          result = await ResQNetBle.broadcastMessage(chunks[i]);
          if (chunks.length > 1 && i < chunks.length - 1) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 12));
          }
        }
        return result;
      } catch (e) {
        console.warn('Native broadcastMessage failed:', e);
        throw e;
      }
    }

    const total = Math.max(1, connectedCount);
    setTimeout(() => {
      this.simListeners?.onMessageDelivered('BROADCAST', 48);

      // First connected peer sends ACK
      if (packet.messageType !== 'ACK') {
        const firstPeer = Array.from(this.simulatedPeers.values())[0];
        if (firstPeer) {
          const ackPacket = createAckPacket(packet, firstPeer.nodeId);
          setTimeout(() => {
            this.simListeners?.onMessageReceived(ackPacket, serializePacket(ackPacket));
          }, 150);
        }
      }
    }, 50);

    return { deliveredCount: total, totalNodes: total };
  }

  public async shareOfflineMapDatabase(): Promise<boolean> {
    if (this.isNativeAvailable && ResQNetBle.shareOfflineMapDatabase) {
      try {
        return await ResQNetBle.shareOfflineMapDatabase();
      } catch (e: any) {
        console.warn('Native shareOfflineMapDatabase error:', e);
        throw e;
      }
    }
    return false;
  }
}

export const bleBridge = new NativeBleBridge();

