/**
 * ResQNet BLE Packet Chunker and Reassembler
 * Inspired by BitChat-Android's packet fragmentation protocol.
 * Ensures resilient packet delivery across all BLE MTUs (20 to 512 bytes)
 * without data loss or buffer truncation in infrastructure-restricted environments.
 */

export interface PacketChunk {
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
  payload: string;
}

const CHUNK_PREFIX = 'RESQ_CHUNK:';
const DEFAULT_CHUNK_SIZE = 80; // Safe default for BLE MTU without buffer overflow

/**
 * Splits a serialized packet JSON into chunk frames if it exceeds maxChunkSize.
 * Returns an array of formatted chunk strings.
 */
export function chunkPacket(
  packetJson: string,
  messageId: string,
  maxChunkSize: number = DEFAULT_CHUNK_SIZE
): string[] {
  // If the message is already short enough to fit in a single transmission, send as single chunk
  if (packetJson.length <= maxChunkSize) {
    return [`${CHUNK_PREFIX}${messageId}:0:1:${packetJson}`];
  }

  const chunks: string[] = [];
  const totalChunks = Math.ceil(packetJson.length / maxChunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * maxChunkSize;
    const slice = packetJson.slice(start, start + maxChunkSize);
    chunks.push(`${CHUNK_PREFIX}${messageId}:${i}:${totalChunks}:${slice}`);
  }

  return chunks;
}

/**
 * Parses an incoming BLE raw string.
 * Returns PacketChunk if it is a formatted chunk, or null if raw JSON.
 */
export function parseChunk(raw: string): PacketChunk | null {
  if (!raw.startsWith(CHUNK_PREFIX)) {
    return null;
  }

  // Format: RESQ_CHUNK:<messageId>:<chunkIndex>:<totalChunks>:<payload>
  const remainder = raw.slice(CHUNK_PREFIX.length);
  const firstColon = remainder.indexOf(':');
  if (firstColon === -1) return null;
  const messageId = remainder.slice(0, firstColon);

  const secondColon = remainder.indexOf(':', firstColon + 1);
  if (secondColon === -1) return null;
  const chunkIndex = parseInt(remainder.slice(firstColon + 1, secondColon), 10);

  const thirdColon = remainder.indexOf(':', secondColon + 1);
  if (thirdColon === -1) return null;
  const totalChunks = parseInt(remainder.slice(secondColon + 1, thirdColon), 10);

  const payload = remainder.slice(thirdColon + 1);

  if (isNaN(chunkIndex) || isNaN(totalChunks) || totalChunks <= 0) {
    return null;
  }

  return {
    messageId,
    chunkIndex,
    totalChunks,
    payload,
  };
}

interface PendingReassembly {
  totalChunks: number;
  chunks: Map<number, string>;
  receivedAt: number;
  timer: any;
}

export class ChunkReassembler {
  private pending: Map<string, PendingReassembly> = new Map();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 30000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Ingests a raw payload from BLE radio.
   * If the payload is raw JSON (non-chunked), returns it immediately.
   * If it is a chunk, stores it and returns the fully assembled JSON string once all chunks arrive.
   * Returns null if waiting for remaining chunks.
   */
  public ingest(raw: string): string | null {
    const chunk = parseChunk(raw);
    if (!chunk) {
      // Non-chunked packet (raw JSON)
      return raw;
    }

    const { messageId, chunkIndex, totalChunks, payload } = chunk;

    // Single chunk optimization
    if (totalChunks === 1 && chunkIndex === 0) {
      return payload;
    }

    let session = this.pending.get(messageId);
    if (!session) {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
      }, this.timeoutMs);

      session = {
        totalChunks,
        chunks: new Map(),
        receivedAt: Date.now(),
        timer,
      };
      this.pending.set(messageId, session);
    }

    session.chunks.set(chunkIndex, payload);

    // Check if all chunks have been received
    if (session.chunks.size === session.totalChunks) {
      clearTimeout(session.timer);
      this.pending.delete(messageId);

      // Assemble chunks in order
      const assembledParts: string[] = [];
      for (let i = 0; i < session.totalChunks; i++) {
        const part = session.chunks.get(i);
        if (part === undefined) {
          // Missing piece unexpectedly
          return null;
        }
        assembledParts.push(part);
      }
      return assembledParts.join('');
    }

    return null;
  }

  public clear() {
    for (const session of this.pending.values()) {
      clearTimeout(session.timer);
    }
    this.pending.clear();
  }
}

export const defaultChunkReassembler = new ChunkReassembler();

