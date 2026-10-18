import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { PeerNode } from '../types/ble';
import { MessageRecord } from '../types/message';
import { getSignalQuality } from '../utils/distance';

interface NearbyPeopleBarProps {
  peers: PeerNode[];
  selectedTargetId: string;
  onSelectTarget: (targetId: string) => void;
  messages?: MessageRecord[];
}

export const NearbyPeopleBar: React.FC<NearbyPeopleBarProps> = ({
  peers,
  selectedTargetId,
  onSelectTarget,
  messages = [],
}) => {
  const isEveryoneSelected =
    selectedTargetId === 'BROADCAST' || selectedTargetId === '#all';
  const connectedPeers = peers.filter(
    (p) => p.connectionState === 'CONNECTED'
  );
  // Show all discovered and connected app nodes
  const displayPeers = peers.filter(
    (p) => p.connectionState === 'CONNECTED' || p.connectionState === 'DISCOVERED'
  );

  return (
    <View style={styles.container}>
      {/* Compact Header Row */}
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>
          NEARBY PEOPLE & TARGETS ({displayPeers.length + 1})
        </Text>
        <Text style={styles.autoHint}>
          {connectedPeers.length > 0
            ? `${connectedPeers.length} Mesh Active`
            : displayPeers.length > 0
            ? `${displayPeers.length} In Range`
            : 'Listening'}
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollRow}
      >
        {/* 'Everyone Nearby' Broadcast Card */}
        <TouchableOpacity
          style={[
            styles.card,
            isEveryoneSelected && styles.cardSelected,
          ]}
          onPress={() => onSelectTarget('BROADCAST')}
          activeOpacity={0.75}
        >
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, styles.broadcastAvatar]}>
              <Text style={styles.broadcastInitial}>ALL</Text>
            </View>
            <View style={[styles.onlineBadge, { backgroundColor: '#38BDF8' }]} />
          </View>
          <Text style={styles.cardName} numberOfLines={1}>
            Everyone
          </Text>
          <Text style={styles.cardDeviceId}>BROADCAST</Text>
          <Text style={styles.cardDist}>All Nearby</Text>
          <View style={styles.factorWrap}>
            <Text style={styles.broadcastFactor}>Mesh Cast</Text>
          </View>
        </TouchableOpacity>

        {/* Real Users Cards with Distance, Signal Strength & Factors */}
        {displayPeers.map((peer) => {
          const username = peer.name || peer.nodeId || 'User';
          const isSelected =
            selectedTargetId === peer.id ||
            selectedTargetId === peer.nodeId ||
            selectedTargetId === username;
          const isConnected = peer.connectionState === 'CONNECTED';
          const signal = getSignalQuality(peer.rssi);

          const directMsgCount = messages.filter(
            (m) =>
              m.direction === 'INCOMING' &&
              (m.packet.senderId === peer.nodeId ||
                m.packet.senderId === peer.id ||
                (!!peer.name && m.packet.senderName === peer.name)) &&
              m.packet.destinationId !== 'BROADCAST' &&
              m.packet.destinationId !== '#all' &&
              !m.packet.destinationId.startsWith('#')
          ).length;

          return (
            <TouchableOpacity
              key={peer.id}
              style={[
                styles.card,
                isSelected && styles.cardSelected,
              ]}
              onPress={() => onSelectTarget(peer.nodeId || peer.id)}
              activeOpacity={0.75}
            >
              <View style={styles.avatarWrap}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitials}>
                    {(username[0] || 'U').toUpperCase()}
                  </Text>
                </View>
                <View
                  style={[
                    styles.onlineBadge,
                    { backgroundColor: isConnected ? '#10B981' : '#38BDF8' },
                  ]}
                />
                {directMsgCount > 0 && (
                  <View style={styles.unreadCountBadge}>
                    <Text style={styles.unreadCountText}>{directMsgCount}</Text>
                  </View>
                )}
              </View>

              <Text style={styles.cardName} numberOfLines={1}>
                {username}
              </Text>

              {/* Fixed Device ID */}
              <Text style={styles.cardDeviceId} numberOfLines={1}>
                {peer.nodeId || 'ERVO-NODE'}
              </Text>

              {/* Distance Factor */}
              <Text style={styles.cardDist}>
                ~{peer.distanceMeters}m • {isConnected ? 'Active' : 'Nearby'}
              </Text>

              {/* Signal Strength & Network Factor */}
              <View style={styles.factorWrap}>
                <Text
                  style={[
                    styles.signalText,
                    { color: signal.color },
                  ]}
                  numberOfLines={1}
                >
                  {peer.rssi} dBm
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  autoHint: {
    fontSize: 9.5,
    color: '#10B981',
    fontWeight: '700',
  },
  scrollRow: {
    paddingHorizontal: 10,
    gap: 7,
  },
  card: {
    width: 90,
    backgroundColor: '#111827',
    borderRadius: 10,
    paddingVertical: 5,
    paddingHorizontal: 4,
    alignItems: 'center',
    borderWidth: 1.2,
    borderColor: '#1F2937',
  },
  cardSelected: {
    borderColor: '#38BDF8',
    backgroundColor: '#0C2A44',
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: 3,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  broadcastAvatar: {
    backgroundColor: '#0284C7',
    borderColor: '#38BDF8',
  },
  broadcastInitial: {
    fontSize: 9.5,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  avatarInitials: {
    fontSize: 12,
    fontWeight: '800',
    color: '#38BDF8',
  },
  onlineBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    borderWidth: 1.2,
    borderColor: '#111827',
  },
  cardName: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#F8FAFC',
    textAlign: 'center',
    width: 82,
  },
  cardDeviceId: {
    fontSize: 8,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.3,
    marginTop: 0.5,
  },
  cardDist: {
    fontSize: 9,
    color: '#94A3B8',
    marginTop: 1,
    textAlign: 'center',
  },
  factorWrap: {
    marginTop: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: '#050811',
  },
  signalText: {
    fontSize: 8.5,
    fontWeight: '700',
  },
  broadcastFactor: {
    fontSize: 8.5,
    fontWeight: '700',
    color: '#38BDF8',
  },
  unreadCountBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#0284C7',
    borderRadius: 7,
    paddingHorizontal: 4,
    minWidth: 14,
    height: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  unreadCountText: {
    fontSize: 7.5,
    fontWeight: '900',
    color: '#FFFFFF',
  },
});
