import {
  computeChecksum,
  createPacket,
  createAckPacket,
  serializePacket,
  parsePacket,
  isControlPacket,
} from '../src/protocol/packetSchema';
import {
  computePacketAuthTag,
  verifyPacketAuthTag,
  encryptPayloadHex,
  decryptPayloadHex,
} from '../src/protocol/security';
import { chunkPacket, parseChunk, ChunkReassembler } from '../src/protocol/chunker';
import { RoutingService } from '../src/services/routingService';
import { storageService } from '../src/services/storageService';
import { PeerNode } from '../src/types/ble';
import { MessageRecord } from '../src/types/message';

describe('Packet Schema & Integrity', () => {
  test('creates, serializes, validates checksum, and parses packet', () => {
    const packet = createPacket({
      senderId: 'ERVO-AAAA',
      senderName: 'Alice',
      destinationId: 'ERVO-FFFF',
      payload: 'Emergency medical aid needed at Sector 4',
      priority: 'URGENT',
      route: ['ERVO-AAAA', 'ERVO-BBBB', 'ERVO-FFFF'],
      routingAlgo: 'DIJKSTRA',
    });

    expect(packet.checksum).toBeTruthy();
    expect(packet.ttl).toBe(10);
    const json = serializePacket(packet);
    const parsed = parsePacket(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.senderId).toBe('ERVO-AAAA');
    expect(parsed?.destinationId).toBe('ERVO-FFFF');
    expect(parsed?.payload).toBe('Emergency medical aid needed at Sector 4');
    expect(parsed?.route).toEqual(['ERVO-AAAA', 'ERVO-BBBB', 'ERVO-FFFF']);
  });

  test('createAckPacket reverses Dijkstra route deterministically', () => {
    const packet = createPacket({
      senderId: 'ERVO-AAAA',
      destinationId: 'ERVO-FFFF',
      payload: 'Ping test',
      route: ['ERVO-AAAA', 'ERVO-BBBB', 'ERVO-CCCC', 'ERVO-FFFF'],
      routingAlgo: 'DIJKSTRA',
    });
    packet.hopCount = 3;

    const ack = createAckPacket(packet, 'ERVO-FFFF');
    expect(ack.messageType).toBe('ACK');
    expect(ack.destinationId).toBe('ERVO-AAAA');
    expect(ack.payload).toBe(`ACK:${packet.messageId}`);
    expect(ack.route).toEqual(['ERVO-FFFF', 'ERVO-CCCC', 'ERVO-BBBB', 'ERVO-AAAA']);
    expect(ack.routingAlgo).toBe('DIJKSTRA');
  });

  test('computeChecksum produces deterministic hex string', () => {
    const c1 = computeChecksum('test|payload');
    const c2 = computeChecksum('test|payload');
    const c3 = computeChecksum('test|changed');
    expect(c1).toBe(c2);
    expect(c1).not.toBe(c3);
  });
});

describe('BLE Packet Chunker & Reassembler', () => {
  test('reassembles multi-chunk packet sent out-of-order', () => {
    const longText = 'RESQ-SECTOR-DATA:'.repeat(40);
    const chunks = chunkPacket(longText, 'msg-123', 100);
    expect(chunks.length).toBeGreaterThan(3);

    const parsed0 = parseChunk(chunks[0]);
    expect(parsed0?.messageId).toBe('msg-123');
    expect(parsed0?.totalChunks).toBe(chunks.length);

    const reassembler = new ChunkReassembler(5000);
    // Deliver chunks in reverse order
    for (let i = chunks.length - 1; i > 0; i--) {
      expect(reassembler.ingest(chunks[i])).toBeNull();
    }
    const finalOutput = reassembler.ingest(chunks[0]);
    expect(finalOutput).toBe(longText);
    reassembler.clear();
  });

  test('passes through non-chunked raw JSON packets immediately', () => {
    const reassembler = new ChunkReassembler(5000);
    const raw = '{"messageId":"m1"}';
    expect(reassembler.ingest(raw)).toBe(raw);
    reassembler.clear();
  });
});

describe('Dijkstra Multi-Hop Routing Engine', () => {
  test('computes shortest 6-node path A -> B -> C -> D -> E -> F via LSAs', () => {
    const router = new RoutingService();
    const directPeerB: PeerNode = {
      id: 'AA:BB:CC:11:22:02',
      name: 'Node B',
      nodeId: 'ERVO-BBBB',
      role: 'Relay Node',
      rssi: -60,
      distanceMeters: 2,
      connectionState: 'CONNECTED',
      lastSeen: Date.now(),
      packetsReceived: 0,
      packetsSent: 0,
    };

    router.updateLocalDirectNeighbors('ERVO-AAAA', 'Node A', [directPeerB]);

    router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-BBBB',
      originName: 'Node B',
      sequenceNumber: 1,
      neighbors: [{ nodeId: 'ERVO-CCCC', name: 'Node C', rssi: -62 }],
      timestamp: Date.now(),
    });
    router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-CCCC',
      originName: 'Node C',
      sequenceNumber: 1,
      neighbors: [{ nodeId: 'ERVO-DDDD', name: 'Node D', rssi: -64 }],
      timestamp: Date.now(),
    });
    router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-DDDD',
      originName: 'Node D',
      sequenceNumber: 1,
      neighbors: [{ nodeId: 'ERVO-EEEE', name: 'Node E', rssi: -61 }],
      timestamp: Date.now(),
    });
    router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-EEEE',
      originName: 'Node E',
      sequenceNumber: 1,
      neighbors: [{ nodeId: 'ERVO-FFFF', name: 'Node F', rssi: -63 }],
      timestamp: Date.now(),
    });

    const route = router.findShortestPath('ERVO-AAAA', 'ERVO-FFFF');
    expect(route).not.toBeNull();
    expect(route?.path).toEqual([
      'ERVO-AAAA',
      'ERVO-BBBB',
      'ERVO-CCCC',
      'ERVO-DDDD',
      'ERVO-EEEE',
      'ERVO-FFFF',
    ]);
    expect(route?.hopCount).toBe(5);
    expect(route?.nextHop).toBe('ERVO-BBBB');

    // Verify getMultiHopPeers hides direct 1-hop B and local A, surfacing C..F
    const multiHop = router.getMultiHopPeers('ERVO-AAAA', [directPeerB]);
    const multiHopIds = multiHop.map((p) => p.nodeId);
    expect(multiHopIds).toContain('ERVO-FFFF');
    expect(multiHopIds).not.toContain('ERVO-AAAA');
    expect(multiHopIds).not.toContain('ERVO-BBBB');
  });

  test('ignores duplicate or stale LSA sequence numbers', () => {
    const router = new RoutingService();
    const first = router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-BBBB',
      originName: 'Node B',
      sequenceNumber: 5,
      neighbors: [],
      timestamp: Date.now(),
    });
    const stale = router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-BBBB',
      originName: 'Node B',
      sequenceNumber: 5,
      neighbors: [],
      timestamp: Date.now(),
    });
    expect(first.updated).toBe(true);
    expect(stale.updated).toBe(false);
    expect(stale.shouldRebroadcast).toBe(false);
  });

  test('resolves exact nextHop along embedded DSR route', () => {
    const router = new RoutingService();
    const pkt = createPacket({
      senderId: 'ERVO-AAAA',
      destinationId: 'ERVO-FFFF',
      payload: 'Relay test',
      route: ['ERVO-AAAA', 'ERVO-BBBB', 'ERVO-CCCC', 'ERVO-FFFF'],
      routeIndex: 1,
    });
    const next = router.getNextHopForRoute(pkt, 'ERVO-BBBB');
    expect(next).toEqual({ nextHop: 'ERVO-CCCC', nextRouteIndex: 2 });
  });
});

describe('Storage Control-Plane Suppression', () => {
  beforeEach(() => {
    storageService.wipeAllData();
  });

  test('drops LSA, ROUTING, PING, and ACK control packets from chat history', () => {
    const lsaRecord: MessageRecord = {
      id: 'lsa-1',
      direction: 'INCOMING',
      status: 'DELIVERED',
      createdAt: Date.now(),
      packet: createPacket({
        senderId: 'ERVO-97DE',
        destinationId: 'BROADCAST',
        payload: '{"type":"LSA","originNodeId":"ERVO-97DE","sequenceNumber":1}',
        messageType: 'TEXT',
      }),
    };
    const pingRecord: MessageRecord = {
      id: 'ping-1',
      direction: 'INCOMING',
      status: 'DELIVERED',
      createdAt: Date.now(),
      packet: createPacket({
        senderId: 'ERVO-97DE',
        destinationId: 'ERVO-TEST',
        payload: 'HANDSHAKE:Tester',
        messageType: 'PING',
      }),
    };
    const userChatRecord: MessageRecord = {
      id: 'chat-1',
      direction: 'INCOMING',
      status: 'DELIVERED',
      createdAt: Date.now(),
      packet: createPacket({
        senderId: 'ERVO-97DE',
        destinationId: 'BROADCAST',
        payload: 'Safe at Main Gate',
        messageType: 'TEXT',
      }),
    };

    storageService.addMessage(lsaRecord);
    storageService.addMessage(pingRecord);
    storageService.addMessage(userChatRecord);

    const messages = storageService.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('chat-1');
  });

  test('routes Mobile A -> ESP32-1 -> ESP32-2 -> Mobile B via ESP32 LSAs', () => {
    const router = new RoutingService();
    const esp1: PeerNode = {
      id: 'AA:BB:CC:00:00:01',
      name: 'ESP32-Relay-P1',
      nodeId: 'ERVO-ESP1',
      role: 'Relay Node',
      rssi: -58,
      distanceMeters: 2,
      connectionState: 'CONNECTED',
      lastSeen: Date.now(),
      packetsReceived: 0,
      packetsSent: 0,
      isRelayCapable: true,
    };

    router.updateLocalDirectNeighbors('ERVO-AAAA', 'Mobile A', [esp1]);
    router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-ESP1',
      originName: 'ESP32-Relay-P1',
      sequenceNumber: 1,
      neighbors: [
        { nodeId: 'ERVO-AAAA', name: 'Mobile A', rssi: -58 },
        { nodeId: 'ERVO-ESP2', name: 'ESP32-Relay-P2', rssi: -62 },
      ],
      timestamp: Date.now(),
    });
    router.processLsa({
      type: 'LSA',
      originNodeId: 'ERVO-ESP2',
      originName: 'ESP32-Relay-P2',
      sequenceNumber: 1,
      neighbors: [
        { nodeId: 'ERVO-ESP1', name: 'ESP32-Relay-P1', rssi: -62 },
        { nodeId: 'ERVO-BBBB', name: 'Mobile B', rssi: -59 },
      ],
      timestamp: Date.now(),
    });

    const route = router.findShortestPath('ERVO-AAAA', 'ERVO-BBBB');
    expect(route).not.toBeNull();
    expect(route?.path).toEqual(['ERVO-AAAA', 'ERVO-ESP1', 'ERVO-ESP2', 'ERVO-BBBB']);
    expect(route?.hopCount).toBe(3);
    expect(route?.nextHop).toBe('ERVO-ESP1');
  });

  test('filters NODE_STATUS, NODE_BEACON, and ROUTE_UPDATE as control packets', () => {
    const statusPkt = createPacket({
      senderId: 'ERVO-ESP1',
      destinationId: 'BROADCAST',
      payload: '{"type":"NODE_STATUS","nodeId":"ERVO-ESP1","queueSize":2}',
      messageType: 'NODE_STATUS',
    });
    const beaconPkt = createPacket({
      senderId: 'ERVO-ESP1',
      destinationId: 'BROADCAST',
      payload: 'BEACON:LOC',
      messageType: 'NODE_BEACON',
    });
    const routePkt = createPacket({
      senderId: 'ERVO-ESP1',
      destinationId: 'BROADCAST',
      payload: '{}',
      messageType: 'ROUTE_UPDATE',
    });
    const mapCmdPkt = createPacket({
      senderId: 'ERVO-ESP1',
      destinationId: 'ERVO-AAAA',
      payload: '{"type":"MAP_SERVER_STATUS","active":true}',
      messageType: 'MAP_SERVER_CMD',
    });
    expect(isControlPacket(statusPkt)).toBe(true);
    expect(isControlPacket(beaconPkt)).toBe(true);
    expect(isControlPacket(routePkt)).toBe(true);
    expect(isControlPacket(mapCmdPkt)).toBe(true);
  });
});

describe('Security HMAC-SHA256 & SHA256-CTR Payload Cipher', () => {
  test('generates and verifies HMAC-SHA256 authTag and encrypts/decrypts UTF-8 payloads', () => {
    const pkt = createPacket({
      senderId: 'ERVO-AAAA',
      destinationId: 'ERVO-BBBB',
      payload: 'Medical aid needed at Gate 3',
      priority: 'CRITICAL_SOS',
    });
    expect(pkt.authTag).toBeTruthy();
    expect(verifyPacketAuthTag(pkt)).toBe(true);

    const tampered = { ...pkt, destinationId: 'ERVO-EVIL' };
    expect(verifyPacketAuthTag(tampered)).toBe(false);
    expect(computePacketAuthTag(pkt)).toBe(pkt.authTag);

    const cipherHex = encryptPayloadHex(pkt.payload, pkt.messageId);
    expect(cipherHex).toMatch(/^[0-9A-F]+$/);
    expect(cipherHex).not.toContain('Medical');
    expect(decryptPayloadHex(cipherHex, pkt.messageId)).toBe(pkt.payload);
  });
});

