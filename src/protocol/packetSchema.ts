import { ResQNetPacket, MessagePriority, MessageType } from '../types/message';
import { generateMessageId } from '../utils/formatters';

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
  return ((b << 16) | a).toString(16).toUpperCase();
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
}): ResQNetPacket {
  const messageId = generateMessageId(params.senderId);
  const timestamp = Date.now();
  const ttl = params.ttl ?? 3;
  const priority = params.priority ?? 'NORMAL';
  const messageType = params.messageType ?? 'TEXT';
  const hopCount = 0;

  const rawForChecksum = `${messageId}|${params.senderId}|${params.destinationId}|${timestamp}|${params.payload}`;
  const checksum = computeChecksum(rawForChecksum);

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
  };
}

/**
 * Creates an ACK packet to confirm receipt
 */
export function createAckPacket(
  originalPacket: ResQNetPacket,
  responderId: string
): ResQNetPacket {
  return createPacket({
    senderId: responderId,
    destinationId: originalPacket.senderId,
    payload: `ACK:${originalPacket.messageId}`,
    priority: originalPacket.priority,
    messageType: 'ACK',
    ttl: 3,
  });
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
        ttl: typeof obj.ttl === 'number' ? obj.ttl : 3,
        priority: obj.priority || 'NORMAL',
        messageType: obj.messageType || 'TEXT',
        payload: obj.payload,
        hopCount: typeof obj.hopCount === 'number' ? obj.hopCount : 0,
        checksum: obj.checksum || '',
      };
    }
  } catch (err) {
    console.warn('Failed to parse ResQNet packet JSON:', err);
  }
  return null;
}

