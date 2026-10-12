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
    // Start with empty peer list; only actual devices discovered via Bluetooth appear
    this.simulatedPeers.clear();
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
        const node: PeerNode = {
          id: data.id,
          name: data.name || data.nodeId || 'Unknown Peer',
          nodeId: data.nodeId || `NODE-${data.id.slice(-4)}`,
          role: 'Field Worker',
          rssi: data.rssi,
          distanceMeters: distance,
          connectionState: 'DISCOVERED',
          lastSeen: Date.now(),
          packetsReceived: 0,
          packetsSent: 0,
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
            }
          }, 800);
        }
        count++;
        this.simTimer = setTimeout(emitNextPeer, 1200);
      }
    };

    this.simTimer = setTimeout(emitNextPeer, 500);

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
        for (const chunk of chunks) {
          await ResQNetBle.sendMessage(targetAddress, chunk);
        }
        return true;
      } catch (e) {
        console.warn('Native sendMessage failed:', e);
        throw e;
      }
    }

    // In simulation mode: simulate over-the-air round-trip latency & ACK response
    const isMultiHop = targetAddress === '11:22:33:77:88:99' || packet.destinationId === 'AID-POINT';
    const latency = isMultiHop ? 85 : Math.floor(Math.random() * 30) + 35; // Multi-hop adds relay delay
    setTimeout(() => {
      this.simListeners?.onMessageDelivered(targetAddress, latency);

      // Destination peer receives packet and returns ACK back across the mesh
      if (packet.messageType !== 'ACK') {
        const peer = this.simulatedPeers.get(targetAddress);
        const peerNodeId = peer ? peer.nodeId : 'RESQ-PEER';
        const ackPacket = createAckPacket(
          { ...packet, hopCount: isMultiHop ? 2 : 1 },
          peerNodeId
        );
        setTimeout(() => {
          this.simListeners?.onMessageReceived(ackPacket, serializePacket(ackPacket));
        }, isMultiHop ? 90 : 50);
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
        for (const chunk of chunks) {
          result = await ResQNetBle.broadcastMessage(chunk);
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
}

export const bleBridge = new NativeBleBridge();

