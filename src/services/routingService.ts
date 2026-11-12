import { PeerNode } from '../types/ble';
import { LsaPayload, NeighborLink, ResQNetPacket } from '../types/message';

export interface DijkstraRoute {
  path: string[]; // ['ERVO-A', 'ERVO-B', 'ERVO-C', 'ERVO-D', 'ERVO-E', 'ERVO-F']
  totalCost: number;
  hopCount: number;
  nextHop: string; // The 1-hop neighbor to transmit to
}

interface TopologyNode {
  nodeId: string;
  name?: string;
  lastSeen: number;
}

interface TopologyEdge {
  toNodeId: string;
  rssi: number;
  cost: number;
  lastUpdated: number;
}

/**
 * Tactical Mesh Routing Engine using Dijkstra's Shortest Path Algorithm
 * with Link-State Advertisements (LSA) and Dynamic Source Routing (DSR).
 */
export class RoutingService {
  private nodes: Map<string, TopologyNode> = new Map();
  // Adjacency list: fromNodeId -> (toNodeId -> TopologyEdge)
  private adjacency: Map<string, Map<string, TopologyEdge>> = new Map();
  private lsaSequenceNumbers: Map<string, number> = new Map();
  private localSequence = 0;

  /**
   * Computes edge weight combining hop penalty and signal quality (RSSI).
   * A strong link (-60 dBm) has cost ~1.0; a weak link (-90 dBm) has cost ~2.0.
   */
  public calculateEdgeCost(rssi: number): number {
    const baseHopCost = 1.0;
    if (rssi >= -65) {
      return baseHopCost;
    }
    // Penalize links worse than -65 dBm
    const penalty = Math.min(2.0, Math.max(0, (-rssi - 65) / 20));
    return baseHopCost + penalty;
  }

  /**
   * Registers or updates a link in the topology graph (bidirectional).
   */
  public addLink(fromNodeId: string, toNodeId: string, rssi: number, fromName?: string, toName?: string) {
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;

    const cleanFrom = fromNodeId.trim().toUpperCase();
    const cleanTo = toNodeId.trim().toUpperCase();
    const now = Date.now();
    const cost = this.calculateEdgeCost(rssi);

    // Register nodes
    if (!this.nodes.has(cleanFrom)) {
      this.nodes.set(cleanFrom, { nodeId: cleanFrom, name: fromName, lastSeen: now });
    } else {
      const node = this.nodes.get(cleanFrom)!;
      node.lastSeen = now;
      if (fromName && !node.name) node.name = fromName;
    }

    if (!this.nodes.has(cleanTo)) {
      this.nodes.set(cleanTo, { nodeId: cleanTo, name: toName, lastSeen: now });
    } else {
      const node = this.nodes.get(cleanTo)!;
      node.lastSeen = now;
      if (toName && !node.name) node.name = toName;
    }

    // Add forward edge
    if (!this.adjacency.has(cleanFrom)) {
      this.adjacency.set(cleanFrom, new Map());
    }
    this.adjacency.get(cleanFrom)!.set(cleanTo, {
      toNodeId: cleanTo,
      rssi,
      cost,
      lastUpdated: now,
    });

    // Add reverse edge
    if (!this.adjacency.has(cleanTo)) {
      this.adjacency.set(cleanTo, new Map());
    }
    this.adjacency.get(cleanTo)!.set(cleanFrom, {
      toNodeId: cleanFrom,
      rssi,
      cost,
      lastUpdated: now,
    });
  }

  /**
   * Syncs the local node's direct 1-hop physical connections into the topology graph.
   */
  public updateLocalDirectNeighbors(localNodeId: string, localName: string, directPeers: PeerNode[]) {
    const cleanLocal = localNodeId.trim().toUpperCase();
    const now = Date.now();

    if (!this.nodes.has(cleanLocal)) {
      this.nodes.set(cleanLocal, { nodeId: cleanLocal, name: localName, lastSeen: now });
    } else {
      const node = this.nodes.get(cleanLocal)!;
      node.lastSeen = now;
      node.name = localName;
    }

    for (const peer of directPeers) {
      if (peer.connectionState === 'CONNECTED' || peer.connectionState === 'DISCOVERED') {
        const peerNodeId = (peer.nodeId || peer.id).trim().toUpperCase();
        this.addLink(cleanLocal, peerNodeId, peer.rssi || -70, localName, peer.name);
      }
    }
  }

  /**
   * Generates a Link-State Advertisement (LSA) payload to broadcast to neighbors.
   */
  public generateLsa(localNodeId: string, localName: string, directPeers: PeerNode[]): LsaPayload {
    this.localSequence++;
    const neighbors: NeighborLink[] = [];

    for (const peer of directPeers) {
      if (peer.connectionState === 'CONNECTED') {
        neighbors.push({
          nodeId: (peer.nodeId || peer.id).trim().toUpperCase(),
          name: peer.name,
          rssi: peer.rssi || -70,
        });
      }
    }

    return {
      type: 'LSA',
      originNodeId: localNodeId.trim().toUpperCase(),
      originName: localName,
      sequenceNumber: this.localSequence,
      neighbors,
      timestamp: Date.now(),
    };
  }

  /**
   * Ingests an incoming LSA from a remote peer, updating the topology graph.
   * Returns true if this is a fresh LSA that should be forwarded across the mesh.
   */
  public processLsa(lsa: LsaPayload): { updated: boolean; shouldRebroadcast: boolean } {
    if (!lsa || !lsa.originNodeId) return { updated: false, shouldRebroadcast: false };

    const origin = lsa.originNodeId.trim().toUpperCase();
    const lastSeq = this.lsaSequenceNumbers.get(origin) || 0;

    // Discard old or duplicate sequence numbers
    if (lsa.sequenceNumber <= lastSeq) {
      return { updated: false, shouldRebroadcast: false };
    }

    this.lsaSequenceNumbers.set(origin, lsa.sequenceNumber);
    const now = Date.now();

    // Register origin node
    if (!this.nodes.has(origin)) {
      this.nodes.set(origin, { nodeId: origin, name: lsa.originName, lastSeen: now });
    } else {
      const node = this.nodes.get(origin)!;
      node.lastSeen = now;
      if (lsa.originName) node.name = lsa.originName;
    }

    // Update edges for all reported neighbors
    for (const neighbor of lsa.neighbors) {
      this.addLink(origin, neighbor.nodeId, neighbor.rssi, lsa.originName, neighbor.name);
    }

    return { updated: true, shouldRebroadcast: true };
  }

  /**
   * Executes Dijkstra's algorithm to compute the shortest, lowest-cost path
   * between sourceNodeId and destNodeId across the multi-hop topology graph.
   */
  public findShortestPath(sourceNodeId: string, destNodeId: string): DijkstraRoute | null {
    if (!sourceNodeId || !destNodeId) return null;

    const source = sourceNodeId.trim().toUpperCase();
    const dest = destNodeId.trim().toUpperCase();

    if (source === dest) return null;

    // Check if dest is reachable in graph
    if (!this.nodes.has(dest) && !this.adjacency.has(dest)) {
      // Destination not registered in topology
      return null;
    }

    const distances = new Map<string, number>();
    const previous = new Map<string, string | null>();
    const unvisited = new Set<string>();

    // Initialize all known nodes
    for (const nodeId of this.nodes.keys()) {
      distances.set(nodeId, Infinity);
      previous.set(nodeId, null);
      unvisited.add(nodeId);
    }
    // Also add any nodes present only as edges
    for (const fromId of this.adjacency.keys()) {
      if (!distances.has(fromId)) {
        distances.set(fromId, Infinity);
        previous.set(fromId, null);
        unvisited.add(fromId);
      }
      for (const toId of this.adjacency.get(fromId)!.keys()) {
        if (!distances.has(toId)) {
          distances.set(toId, Infinity);
          previous.set(toId, null);
          unvisited.add(toId);
        }
      }
    }

    distances.set(source, 0);

    while (unvisited.size > 0) {
      // Find node with minimum distance in unvisited
      let current: string | null = null;
      let minDistance = Infinity;

      for (const node of unvisited) {
        const d = distances.get(node) ?? Infinity;
        if (d < minDistance) {
          minDistance = d;
          current = node;
        }
      }

      if (!current || minDistance === Infinity) {
        break; // Remaining nodes are unreachable
      }

      if (current === dest) {
        break; // Reached target destination!
      }

      unvisited.delete(current);

      const neighbors = this.adjacency.get(current);
      if (neighbors) {
        for (const [neighborId, edge] of neighbors.entries()) {
          if (!unvisited.has(neighborId)) continue;

          const alt = minDistance + edge.cost;
          if (alt < (distances.get(neighborId) ?? Infinity)) {
            distances.set(neighborId, alt);
            previous.set(neighborId, current);
          }
        }
      }
    }

    // Check if destination was reached
    const destDistance = distances.get(dest);
    if (!destDistance || destDistance === Infinity) {
      return null;
    }

    // Reconstruct path backwards from dest to source
    const path: string[] = [];
    let curr: string | null = dest;

    while (curr) {
      path.unshift(curr);
      curr = previous.get(curr) || null;
      if (curr === source) {
        path.unshift(source);
        break;
      }
    }

    // Ensure path starts with source and ends with dest
    if (path.length < 2 || path[0] !== source || path[path.length - 1] !== dest) {
      return null;
    }

    return {
      path,
      totalCost: destDistance,
      hopCount: path.length - 1,
      nextHop: path[1],
    };
  }

  /**
   * Resolves the next hop along an existing packet's Dijkstra route.
   */
  public getNextHopForRoute(
    packet: ResQNetPacket,
    localNodeId: string
  ): { nextHop: string; nextRouteIndex: number } | null {
    if (!packet.route || packet.route.length < 2) return null;

    const cleanLocal = localNodeId.trim().toUpperCase();
    const route = packet.route.map((n) => n.trim().toUpperCase());

    // Locate local node in route
    let myIndex = route.indexOf(cleanLocal);
    if (myIndex === -1 && typeof packet.routeIndex === 'number' && packet.routeIndex < route.length) {
      myIndex = packet.routeIndex;
    }

    if (myIndex === -1 || myIndex >= route.length - 1) {
      return null;
    }

    const nextIndex = myIndex + 1;
    return {
      nextHop: route[nextIndex],
      nextRouteIndex: nextIndex,
    };
  }

  /**
   * Retrieves all multi-hop distant nodes discovered in the mesh
   * that are not direct 1-hop physical peers of the local node.
   */
  public getMultiHopPeers(localNodeId: string, directPeers: PeerNode[]): PeerNode[] {
    const cleanLocal = localNodeId.trim().toUpperCase();
    const directIds = new Set<string>();

    for (const p of directPeers) {
      if (p.nodeId) directIds.add(p.nodeId.trim().toUpperCase());
      if (p.id) directIds.add(p.id.trim().toUpperCase());
    }

    const multiHopPeers: PeerNode[] = [];
    const now = Date.now();

    for (const [nodeId, info] of this.nodes.entries()) {
      if (nodeId === cleanLocal) continue;
      if (directIds.has(nodeId)) continue;

      // Clean check: exclude self suffix
      const localSuffix = cleanLocal.replace('ERVO-', '').replace('RESQ-', '');
      const nodeSuffix = nodeId.replace('ERVO-', '').replace('RESQ-', '');
      if (localSuffix && nodeSuffix && localSuffix === nodeSuffix) continue;

      // Drop nodes silent for > 90 seconds
      if (now - info.lastSeen > 90000) continue;

      // Calculate shortest path to verify reachability
      const route = this.findShortestPath(cleanLocal, nodeId);
      if (route && route.path.length >= 2) {
        const cleanName = info.name || `User (${nodeId.replace('ERVO-', '').replace('RESQ-', '')})`;
        const estimatedRssi = Math.max(-95, -60 - (route.hopCount - 1) * 7);

        multiHopPeers.push({
          id: nodeId,
          name: cleanName,
          nodeId: nodeId,
          role: 'Relay Node',
          rssi: estimatedRssi,
          distanceMeters: route.hopCount * 15,
          connectionState: 'CONNECTED', // Reachable via multi-hop relay
          lastSeen: info.lastSeen,
          packetsReceived: 0,
          packetsSent: 0,
          isRelayCapable: true,
          isMultiHop: true,
          hopCount: route.hopCount,
          viaNodeId: route.nextHop,
          relayPath: route.path,
        });
      }
    }

    return multiHopPeers;
  }

  /**
   * Clears stale links older than maxAgeMs (default 90s).
   */
  public pruneStaleLinks(maxAgeMs = 90000) {
    const now = Date.now();
    for (const [fromId, neighbors] of this.adjacency.entries()) {
      for (const [toId, edge] of neighbors.entries()) {
        if (now - edge.lastUpdated > maxAgeMs) {
          neighbors.delete(toId);
        }
      }
      if (neighbors.size === 0) {
        this.adjacency.delete(fromId);
      }
    }
  }

  /**
   * Returns current topology snapshot for diagnostics.
   */
  public getTopologySnapshot() {
    const nodes = Array.from(this.nodes.values());
    const links: { from: string; to: string; rssi: number; cost: number }[] = [];

    for (const [from, neighbors] of this.adjacency.entries()) {
      for (const [to, edge] of neighbors.entries()) {
        if (from < to) {
          links.push({ from, to, rssi: edge.rssi, cost: edge.cost });
        }
      }
    }

    return { nodes, links };
  }
}

export const routingService = new RoutingService();

