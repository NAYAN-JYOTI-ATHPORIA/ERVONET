import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { PeerNode } from '../types/ble';
import { estimateDistanceMeters, getSignalQuality } from '../utils/distance';

interface OfflineMeshMapProps {
  localNodeId: string;
  localName: string;
  peers: PeerNode[];
  onOpenChat: (targetId: string) => void;
  onConnectPeer?: (address: string) => void;
  style?: any;
}

// Consistent angle derivation based on peer identity string
function deriveAngleFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const deg = Math.abs(hash % 360);
  return (deg * Math.PI) / 180;
}

export const OfflineMeshMap: React.FC<OfflineMeshMapProps> = ({
  localNodeId,
  localName,
  peers,
  onOpenChat,
  onConnectPeer,
  style,
}) => {
  const [maxRange, setMaxRange] = useState<number>(30); // 15m, 30m, 50m
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);

  const displayPeers = peers.filter(
    (p) => p.connectionState === 'CONNECTED' || p.connectionState === 'DISCOVERED'
  );

  const selectedPeer = displayPeers.find(
    (p) => p.id === selectedPeerId || p.nodeId === selectedPeerId
  );

  const CANVAS_SIZE = 290;
  const CENTER = CANVAS_SIZE / 2;
  const MAX_RADIUS = CENTER - 26;

  return (
    <View style={[styles.container, style]}>
      {/* Top Map Toolbar & Range Selectors */}
      <View style={styles.headerRow}>
        <View>
          <View style={styles.titleRow}>
            <View style={styles.radarLiveDot} />
            <Text style={styles.sectionTitle}>OFFLINE TACTICAL RADAR MAP</Text>
          </View>
          <Text style={styles.sectionSub}>
            Zero Internet • Proximity & Range Positioning
          </Text>
        </View>

        {/* Range Selector Pills (15m, 30m, 50m) */}
        <View style={styles.rangeSelector}>
          {[15, 30, 50].map((r) => (
            <TouchableOpacity
              key={r}
              style={[
                styles.rangeBtn,
                maxRange === r && styles.rangeBtnActive,
              ]}
              onPress={() => setMaxRange(r)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.rangeBtnText,
                  maxRange === r && styles.rangeBtnTextActive,
                ]}
              >
                {r}m
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Offline Vector Radar Canvas */}
      <View style={styles.canvasContainer}>
        <View style={[styles.canvas, { width: CANVAS_SIZE, height: CANVAS_SIZE }]}>
          {/* Concentric Distance Rings */}
          {/* Outer Ring */}
          <View
            style={[
              styles.ring,
              {
                width: MAX_RADIUS * 2,
                height: MAX_RADIUS * 2,
                borderRadius: MAX_RADIUS,
                top: CENTER - MAX_RADIUS,
                left: CENTER - MAX_RADIUS,
              },
            ]}
          />
          <Text
            style={[
              styles.ringLabel,
              { top: CENTER - MAX_RADIUS + 2, left: CENTER + 3 },
            ]}
          >
            {maxRange}m
          </Text>

          {/* Middle Ring */}
          <View
            style={[
              styles.ring,
              {
                width: MAX_RADIUS * 1.33,
                height: MAX_RADIUS * 1.33,
                borderRadius: (MAX_RADIUS * 1.33) / 2,
                top: CENTER - (MAX_RADIUS * 1.33) / 2,
                left: CENTER - (MAX_RADIUS * 1.33) / 2,
              },
            ]}
          />
          <Text
            style={[
              styles.ringLabel,
              { top: CENTER - (MAX_RADIUS * 1.33) / 2 + 2, left: CENTER + 3 },
            ]}
          >
            {Math.round((maxRange * 2) / 3)}m
          </Text>

          {/* Inner Ring */}
          <View
            style={[
              styles.ring,
              {
                width: MAX_RADIUS * 0.66,
                height: MAX_RADIUS * 0.66,
                borderRadius: (MAX_RADIUS * 0.66) / 2,
                top: CENTER - (MAX_RADIUS * 0.66) / 2,
                left: CENTER - (MAX_RADIUS * 0.66) / 2,
              },
            ]}
          />
          <Text
            style={[
              styles.ringLabel,
              { top: CENTER - (MAX_RADIUS * 0.66) / 2 + 2, left: CENTER + 3 },
            ]}
          >
            {Math.round(maxRange / 3)}m
          </Text>

          {/* Crosshairs & Cardinal Directions */}
          <View style={[styles.crosshairH, { top: CENTER, width: CANVAS_SIZE }]} />
          <View style={[styles.crosshairV, { left: CENTER, height: CANVAS_SIZE }]} />

          <Text style={[styles.cardinal, { top: 6, left: CENTER - 5 }]}>N</Text>
          <Text style={[styles.cardinal, { bottom: 6, left: CENTER - 4 }]}>S</Text>
          <Text style={[styles.cardinal, { right: 6, top: CENTER - 7 }]}>E</Text>
          <Text style={[styles.cardinal, { left: 6, top: CENTER - 7 }]}>W</Text>

          {/* Center: Local Node (YOU) */}
          <View style={[styles.centerNodeWrap, { top: CENTER - 12, left: CENTER - 12 }]}>
            <View style={styles.centerNodePulse} />
            <View style={styles.centerNode}>
              <Text style={styles.centerNodeText}>YOU</Text>
            </View>
          </View>

          {/* Render Discovered & Connected Nodes on Radar */}
          {displayPeers.map((peer) => {
            const isConnected = peer.connectionState === 'CONNECTED';
            const dist = peer.rssi ? estimateDistanceMeters(peer.rssi) : 10;
            const normDist = Math.min(1, Math.max(0.12, dist / maxRange));
            const angle = deriveAngleFromId(peer.nodeId || peer.id);

            // Compute cartesian coordinates
            const x = CENTER + normDist * MAX_RADIUS * Math.cos(angle);
            const y = CENTER + normDist * MAX_RADIUS * Math.sin(angle);

            const isSelected =
              selectedPeerId === peer.id || selectedPeerId === peer.nodeId;
            const peerInitial = (peer.name?.[0] || peer.nodeId?.[0] || 'U').toUpperCase();

            return (
              <TouchableOpacity
                key={peer.id}
                style={[
                  styles.peerPin,
                  {
                    left: x - 13,
                    top: y - 13,
                  },
                  isConnected ? styles.peerPinConnected : styles.peerPinDiscovered,
                  isSelected && styles.peerPinSelected,
                ]}
                onPress={() => setSelectedPeerId(peer.nodeId || peer.id)}
                activeOpacity={0.8}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.peerPinText}>{peerInitial}</Text>
                {/* Micro distance badge below pin */}
                <View style={styles.pinDistBadge}>
                  <Text style={styles.pinDistText}>~{dist}m</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Selected Peer Tactical Dossier / Quick Action */}
      {selectedPeer ? (
        <View style={styles.dossierCard}>
          <View style={styles.dossierHeader}>
            <View style={styles.dossierAvatar}>
              <Text style={styles.dossierAvatarText}>
                {(selectedPeer.name?.[0] || selectedPeer.nodeId?.[0] || 'U').toUpperCase()}
              </Text>
            </View>
            <View style={styles.dossierInfo}>
              <View style={styles.dossierTitleRow}>
                <Text style={styles.dossierName} numberOfLines={1}>
                  {selectedPeer.name || selectedPeer.nodeId}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    selectedPeer.connectionState === 'CONNECTED'
                      ? styles.statusPillGreen
                      : styles.statusPillAmber,
                  ]}
                >
                  <Text style={styles.statusPillText}>
                    {selectedPeer.connectionState === 'CONNECTED'
                      ? 'CONNECTED'
                      : 'IN RANGE'}
                  </Text>
                </View>
              </View>
              <Text style={styles.dossierMeta}>
                ID: {selectedPeer.nodeId} • ~
                {selectedPeer.rssi
                  ? estimateDistanceMeters(selectedPeer.rssi)
                  : 10}
                m • {selectedPeer.rssi || -75} dBm
              </Text>
            </View>
          </View>

          <View style={styles.dossierActionRow}>
            {selectedPeer.connectionState !== 'CONNECTED' && onConnectPeer && (
              <TouchableOpacity
                style={styles.dossierConnectBtn}
                onPress={() => onConnectPeer(selectedPeer.id)}
                activeOpacity={0.7}
              >
                <Text style={styles.dossierConnectBtnText}>Connect</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.dossierChatBtn}
              onPress={() => onOpenChat(selectedPeer.nodeId || selectedPeer.id)}
              activeOpacity={0.75}
            >
              <Text style={styles.dossierChatBtnText}>
                Open Dedicated Chat ➔
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.emptyMapHint}>
          <Text style={styles.emptyMapHintText}>
            {displayPeers.length > 0
              ? `📍 ${displayPeers.length} node(s) plotted on radar. Tap any node pin to view distance & start chat.`
              : '📡 Radar scanning for nearby ERVONET phones over Bluetooth...'}
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#162032',
    marginHorizontal: 10,
    marginTop: 8,
    marginBottom: 20,
    padding: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  radarLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
  },
  sectionTitle: {
    fontSize: 10.5,
    fontWeight: '900',
    color: '#E2E8F0',
    letterSpacing: 0.8,
  },
  sectionSub: {
    fontSize: 9,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 1,
  },
  rangeSelector: {
    flexDirection: 'row',
    backgroundColor: '#0F172A',
    borderRadius: 6,
    padding: 2,
    borderWidth: 0.8,
    borderColor: '#1E293B',
    gap: 2,
  },
  rangeBtn: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  rangeBtnActive: {
    backgroundColor: '#0284C7',
  },
  rangeBtnText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94A3B8',
  },
  rangeBtnTextActive: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  canvasContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  canvas: {
    backgroundColor: '#040711',
    borderRadius: 145,
    borderWidth: 1.5,
    borderColor: '#111D33',
    position: 'relative',
    overflow: 'visible',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: '#0F223D',
    borderStyle: 'dashed',
  },
  ringLabel: {
    position: 'absolute',
    fontSize: 7.5,
    fontWeight: '800',
    color: '#334D6E',
    letterSpacing: 0.5,
  },
  crosshairH: {
    position: 'absolute',
    height: 1,
    backgroundColor: '#0F223D',
  },
  crosshairV: {
    position: 'absolute',
    width: 1,
    backgroundColor: '#0F223D',
  },
  cardinal: {
    position: 'absolute',
    fontSize: 8.5,
    fontWeight: '900',
    color: '#0284C7',
    opacity: 0.6,
  },
  centerNodeWrap: {
    position: 'absolute',
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerNodePulse: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#0284C7',
    opacity: 0.25,
  },
  centerNode: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#0284C7',
    borderWidth: 1.5,
    borderColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerNodeText: {
    fontSize: 6.5,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  peerPin: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#0F2038',
    borderWidth: 1.8,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  peerPinConnected: {
    borderColor: '#10B981',
    backgroundColor: '#08281E',
  },
  peerPinDiscovered: {
    borderColor: '#38BDF8',
    backgroundColor: '#0C223D',
  },
  peerPinSelected: {
    borderColor: '#F59E0B',
    transform: [{ scale: 1.15 }],
    zIndex: 20,
  },
  peerPinText: {
    fontSize: 10.5,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  pinDistBadge: {
    position: 'absolute',
    bottom: -13,
    backgroundColor: '#000000',
    paddingHorizontal: 3,
    paddingVertical: 0.5,
    borderRadius: 3,
    borderWidth: 0.5,
    borderColor: '#1E293B',
  },
  pinDistText: {
    fontSize: 7.5,
    fontWeight: '800',
    color: '#94A3B8',
  },
  dossierCard: {
    backgroundColor: '#060B18',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
    padding: 10,
    marginTop: 10,
  },
  dossierHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  dossierAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#0F1F38',
    borderWidth: 1.2,
    borderColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierAvatarText: {
    fontSize: 13,
    fontWeight: '900',
    color: '#38BDF8',
  },
  dossierInfo: {
    flex: 1,
  },
  dossierTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  dossierName: {
    fontSize: 13,
    fontWeight: '900',
    color: '#F8FAFC',
    maxWidth: 160,
  },
  statusPill: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  statusPillGreen: {
    backgroundColor: '#064E3B',
  },
  statusPillAmber: {
    backgroundColor: '#78350F',
  },
  statusPillText: {
    fontSize: 8.5,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  dossierMeta: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94A3B8',
  },
  dossierActionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dossierConnectBtn: {
    backgroundColor: '#1E293B',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 0.8,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierConnectBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#38BDF8',
  },
  dossierChatBtn: {
    flex: 1,
    backgroundColor: '#0284C7',
    paddingVertical: 7,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierChatBtnText: {
    fontSize: 11.5,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.4,
  },
  emptyMapHint: {
    alignItems: 'center',
    paddingVertical: 8,
    marginTop: 4,
  },
  emptyMapHintText: {
    fontSize: 10.5,
    fontWeight: '600',
    color: '#64748B',
    textAlign: 'center',
  },
});

