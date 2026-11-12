import { ResQNetPacket, MessagePriority, MessageType } from '../types/message';
import { generateMessageId } from '../utils/formatters';
import { computePacketAuthTag } from './security';

/**
 * Computes a simple fast Adler-32 / CRC checksum for packet integrity validation
 */
export function computeChecksum(str: string): string {
  let a = 1;
  let b = 0;
  const MOD_ADLER = 65521;
  for (let i = 0; i < str.length; i++) {
    a = (a + str.charCodeAt(i)) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  // eslint-disable-next-line no-bitwise
  return (((b << 16) | a) >>> 0).toString(16).toUpperCase();
}

/**
 * Constructs a valid ResQNetPacket
 */
export function createPacket(params: {
  senderId: string;
  senderName?: string;
  destinationId: string;
  payload: string;
  priority?: MessagePriority;
  messageType?: MessageType;
  ttl?: number;
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  route?: string[];
  routeIndex?: number;
  routingAlgo?: 'DIJKSTRA' | 'FLOOD';
  visitedNodes?: string[];
  relayTrace?: string[];
}): ResQNetPacket {
  const messageId = generateMessageId(params.senderId);
  const timestamp = Date.now();
  const ttl = params.ttl ?? 10; // Default 10 hops for robust multi-hop mesh forwarding
  const priority = params.priority ?? 'NORMAL';
  const messageType = params.messageType ?? 'TEXT';
  const hopCount = 0;

  const rawForChecksum = `${messageId}|${params.senderId}|${params.destinationId}|${timestamp}|${params.payload}`;
  const checksum = computeChecksum(rawForChecksum);
  const authTag = computePacketAuthTag({
    messageId,
    senderId: params.senderId,
    destinationId: params.destinationId,
    timestamp,
  });

  return {
    messageId,
    senderId: params.senderId,
    senderName: params.senderName,
    destinationId: params.destinationId,
    timestamp,
    ttl,
    priority,
    messageType,
    payload: params.payload,
    hopCount,
    checksum,
    authTag,
    location: params.location,
    route: params.route,
    routeIndex: params.routeIndex,
    routingAlgo: params.routingAlgo,
    visitedNodes: params.visitedNodes,
    relayTrace: params.relayTrace,
  };
}

/**
 * Creates an ACK packet to confirm receipt, reversing the Dijkstra path if available
 */
export function createAckPacket(
  originalPacket: ResQNetPacket,
  responderId: string
): ResQNetPacket {
  // If original packet traversed a Dijkstra route, reverse the route for deterministic return ACK
  let reversedRoute: string[] | undefined;
  if (originalPacket.route && originalPacket.route.length >= 2) {
    reversedRoute = [...originalPacket.route].reverse();
  }

  const ackTtl = Math.max(10, (originalPacket.hopCount || 1) + 4);

  return createPacket({
    senderId: responderId,
    destinationId: originalPacket.senderId,
    payload: `ACK:${originalPacket.messageId}`,
    priority: originalPacket.priority,
    messageType: 'ACK',
    ttl: ackTtl,
    route: reversedRoute,
    routeIndex: 0,
    routingAlgo: reversedRoute ? 'DIJKSTRA' : 'FLOOD',
    visitedNodes: [responderId],
  });
}

/**
 * Identifies internal mesh/control packets that must never be stored or rendered in user chat feeds.
 */
export function isControlPacket(packet: ResQNetPacket): boolean {
  const msgType = packet.messageType;
  const payload = packet.payload || '';
  const dest = packet.destinationId;

  return (
    msgType === 'ROUTING' ||
    msgType === 'PING' ||
    msgType === 'ACK' ||
    msgType === 'NODE_BEACON' ||
    msgType === 'NODE_STATUS' ||
    msgType === 'ROUTE_UPDATE' ||
    msgType === 'MAP_SERVER_CMD' ||
    dest === '__ROUTING_CONTROL__' ||
    dest === 'MESH_ROUTING' ||
    payload.includes('"type":"LSA"') ||
    payload.startsWith('{"type":"LSA"') ||
    payload.startsWith('{"type":"NODE_STATUS"') ||
    payload.startsWith('{"type":"MAP_SERVER_STATUS"') ||
    payload.startsWith('BEACON:') ||
    payload.startsWith('HANDSHAKE:') ||
    payload.startsWith('ACK:')
  );
}

/**
 * Serializes packet to JSON string for BLE transmission
 */
export function serializePacket(packet: ResQNetPacket): string {
  return JSON.stringify(packet);
}

/**
 * Parses and validates received JSON string into ResQNetPacket
 */
export function parsePacket(rawJson: string): ResQNetPacket | null {
  try {
    const obj = JSON.parse(rawJson);
    if (
      typeof obj.messageId === 'string' &&
      typeof obj.senderId === 'string' &&
      typeof obj.destinationId === 'string' &&
      typeof obj.payload === 'string' &&
      typeof obj.timestamp === 'number'
    ) {
      // Validate checksum if provided
      if (obj.checksum) {
        const rawForChecksum = `${obj.messageId}|${obj.senderId}|${obj.destinationId}|${obj.timestamp}|${obj.payload}`;
        const calculated = computeChecksum(rawForChecksum);
        if (calculated !== obj.checksum) {
          console.warn('Packet checksum mismatch:', obj.checksum, 'vs', calculated);
        }
      }

      return {
        messageId: obj.messageId,
        senderId: obj.senderId,
        senderName: typeof obj.senderName === 'string' ? obj.senderName : undefined,
        destinationId: obj.destinationId,
        timestamp: obj.timestamp,
        ttl: typeof obj.ttl === 'number' ? obj.ttl : 10,
        priority: obj.priority || 'NORMAL',
        messageType: obj.messageType || 'TEXT',
        payload: obj.payload,
        hopCount: typeof obj.hopCount === 'number' ? obj.hopCount : 0,
        checksum: obj.checksum || '',
        authTag: typeof obj.authTag === 'string' ? obj.authTag : undefined,
        encrypted: typeof obj.encrypted === 'boolean' ? obj.encrypted : undefined,
        location:
          obj.location &&
          typeof obj.location.latitude === 'number' &&
          typeof obj.location.longitude === 'number'
            ? {
                latitude: obj.location.latitude,
                longitude: obj.location.longitude,
                accuracy:
                  typeof obj.location.accuracy === 'number'
                    ? obj.location.accuracy
                    : undefined,
              }
            : undefined,
        route: Array.isArray(obj.route) ? obj.route : undefined,
        routeIndex: typeof obj.routeIndex === 'number' ? obj.routeIndex : undefined,
        routingAlgo: obj.routingAlgo === 'DIJKSTRA' || obj.routingAlgo === 'FLOOD' ? obj.routingAlgo : undefined,
        visitedNodes: Array.isArray(obj.visitedNodes) ? obj.visitedNodes : undefined,
        relayTrace: Array.isArray(obj.relayTrace) ? obj.relayTrace : undefined,
      };
    }
  } catch (err) {
    console.warn('Failed to parse ResQNet packet JSON:', err);
  }
  return null;
}

