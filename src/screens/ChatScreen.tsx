import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  BackHandler,
  Platform,
  Alert,
} from 'react-native';
import { PeerNode, RadioState } from '../types/ble';
import { MessageRecord } from '../types/message';
import { LocalNodeConfig } from '../services/storageService';
import { EmergencyPreset, USER_FRIENDLY_PRESETS } from '../protocol/emergencyAlerts';
import { ChatFeed } from '../components/ChatFeed';
import { ChatInputBar } from '../components/ChatInputBar';
import { getSignalQuality, estimateDistanceMeters } from '../utils/distance';

interface ChatScreenProps {
  targetId: string;
  peer?: PeerNode;
  localNodeId: string;
  localConfig: LocalNodeConfig;
  messages: MessageRecord[];
  radioState: RadioState;
  onBack: () => void;
  onSendMessage: (text: string) => Promise<boolean>;
  onSendPreset: (preset: EmergencyPreset) => Promise<void>;
  onClearChat: () => void;
  onDeleteMessage: (messageId: string) => void;
  onRetryMessage: (messageId: string) => void;
  onConnectPeer?: (address: string) => void;
  onDisconnectPeer?: (address: string) => void;
}

export const ChatScreen: React.FC<ChatScreenProps> = ({
  targetId,
  peer,
  localNodeId,
  localConfig,
  messages,
  radioState,
  onBack,
  onSendMessage,
  onSendPreset,
  onClearChat,
  onDeleteMessage,
  onRetryMessage,
  onConnectPeer,
  onDisconnectPeer,
}) => {
  // Handle Android hardware back button
  useEffect(() => {
    const backAction = () => {
      onBack();
      return true; // prevent default behavior (exiting app)
    };

    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => backHandler.remove();
  }, [onBack]);

  const isBroadcast = targetId === 'BROADCAST' || targetId === '#all';
  const isChannel = targetId.startsWith('#') && targetId !== '#all';

  // Format header title and status
  let headerTitle = 'Everyone';
  let headerSubtitle = 'All Nearby Mesh Nodes • Broadcast';
  let initial = 'ALL';
  let isConnected = false;
  let signalInfo = null;

  if (isBroadcast) {
    headerTitle = 'Everyone (Broadcast)';
    const connectedCount = radioState.connectedCount;
    headerSubtitle = connectedCount > 0
      ? `Active Mesh • ${connectedCount} peer(s) connected`
      : 'Offline Broadcast • Flooding all nearby devices';
    initial = 'ALL';
  } else if (isChannel) {
    headerTitle = `Channel ${targetId.toUpperCase()}`;
    initial = targetId.slice(1, 3).toUpperCase();
    if (targetId === '#emergency') {
      headerSubtitle = 'Urgent Responders & Distress Channel';
    } else if (targetId === '#medical') {
      headerSubtitle = 'Medical First Aid & Triage Channel';
    } else if (targetId === '#supplies') {
      headerSubtitle = 'Food, Water & Logistics Channel';
    } else {
      headerSubtitle = 'Crisis Offline Mesh Channel';
    }
  } else {
    // 1-on-1 Direct Peer Chat
    const name = peer?.name || targetId;
    headerTitle = name;
    initial = (name[0] || 'U').toUpperCase();
    isConnected = peer?.connectionState === 'CONNECTED';
    if (peer?.rssi) {
      signalInfo = getSignalQuality(peer.rssi);
    }
    const estimatedMeters = peer?.rssi ? estimateDistanceMeters(peer.rssi) : null;
    const distText = estimatedMeters ? `~${estimatedMeters}m` : 'In Range';
    const rssiText = peer?.rssi ? `${peer.rssi} dBm` : '';
    const stateText = isConnected ? 'Connected' : peer?.connectionState === 'CONNECTING' ? 'Connecting...' : 'Discovered';

    headerSubtitle = `${peer?.nodeId || targetId} • ${distText}${rssiText ? ` • ${rssiText}` : ''} • ${stateText}`;
  }

  // Strict Segregation Filter for this dedicated view
  const filteredMessages = messages.filter((m) => {
    // Critical SOS alerts broadcast to all active views
    if (m.packet.priority === 'CRITICAL_SOS') {
      return true;
    }

    const isMessageBroadcast =
      m.packet.destinationId === 'BROADCAST' ||
      m.packet.destinationId === '#all';

    // 1. Everyone / Broadcast View
    if (isBroadcast) {
      return isMessageBroadcast;
    }

    // 2. Preset Crisis Channels (#emergency, #medical, #supplies)
    if (isChannel) {
      if (targetId === '#emergency') {
        return (
          m.packet.destinationId === '#emergency' ||
          m.packet.priority === 'URGENT' ||
          m.packet.payload.includes('[#EMERGENCY]')
        );
      }
      return (
        m.packet.destinationId === targetId ||
        m.packet.payload.includes(`[${targetId.toUpperCase()}]`)
      );
    }

    // 3. Direct 1-on-1 Personal Chat
    // Broadcast messages or channel messages MUST NEVER appear in 1-on-1 personal chat!
    if (isMessageBroadcast || m.packet.destinationId.startsWith('#')) {
      return false;
    }

    const peerAddress = peer?.id;
    const peerNodeId = peer?.nodeId || targetId;
    const peerName = peer?.name;

    const myNodeId = localConfig.deviceId || localConfig.nodeId;
    const myName = localConfig.displayName || localConfig.name;

    const matchesPeer = (id?: string, nameStr?: string) => {
      if (!id && !nameStr) return false;
      return (
        id === targetId ||
        id === peerNodeId ||
        (!!peerAddress && id === peerAddress) ||
        (!!peerName && (id === peerName || nameStr === peerName))
      );
    };

    const matchesMe = (id?: string, nameStr?: string) => {
      if (!id && !nameStr) return false;
      return (
        id === myNodeId ||
        id === localConfig.nodeId ||
        (!!myName && (id === myName || nameStr === myName))
      );
    };

    // Case A: Outgoing personal message sent by Me directly to this peer
    const isOutgoingToThisPeer =
      m.direction === 'OUTGOING' && matchesPeer(m.packet.destinationId);

    // Case B: Incoming personal message sent by this peer directly to Me
    const isIncomingFromThisPeer =
      m.direction === 'INCOMING' &&
      matchesPeer(m.packet.senderId, m.packet.senderName) &&
      matchesMe(m.packet.destinationId);

    return isOutgoingToThisPeer || isIncomingFromThisPeer;
  });

  return (
    <View style={styles.container}>
      {/* Dedicated Clean Navigation Top Bar */}
      <View style={styles.navBar}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={onBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.7}
        >
          <Text style={styles.backIcon}>←</Text>
          <Text style={styles.backText}>Hub</Text>
        </TouchableOpacity>

        <View style={styles.targetAvatar}>
          <Text style={styles.avatarInitial}>{initial}</Text>
          {!isBroadcast && !isChannel && (
            <View
              style={[
                styles.onlineDot,
                isConnected ? styles.dotGreen : styles.dotAmber,
              ]}
            />
          )}
        </View>

        <View style={styles.titleContainer}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {headerSubtitle}
          </Text>
        </View>

        {/* Right Action: Connection Toggle or Clear Chat */}
        <View style={styles.rightActions}>
          {!isBroadcast && !isChannel && peer && !isConnected && onConnectPeer && (
            <TouchableOpacity
              style={styles.connectPill}
              onPress={() => onConnectPeer(peer.id)}
              activeOpacity={0.7}
            >
              <Text style={styles.connectPillText}>Connect</Text>
            </TouchableOpacity>
          )}

          {filteredMessages.length > 0 && (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={onClearChat}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
            >
              <Text style={styles.actionBtnText}>🗑️</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Emergency Quick Presets Bar inside Dedicated Chat for rapid 1-tap responses */}
      <View style={styles.presetStrip}>
        {USER_FRIENDLY_PRESETS.slice(0, 4).map((preset) => (
          <TouchableOpacity
            key={preset.id}
            style={[
              styles.presetChip,
              preset.priority === 'CRITICAL_SOS' && styles.presetChipSos,
            ]}
            onPress={() => onSendPreset(preset)}
            activeOpacity={0.75}
          >
            <Text
              style={[
                styles.presetChipText,
                preset.priority === 'CRITICAL_SOS' && styles.presetChipTextSos,
              ]}
              numberOfLines={1}
            >
              {preset.title}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Full-Height Spacious Chat Feed */}
      <View style={styles.feedWrapper}>
        <ChatFeed
          messages={filteredMessages}
          localNodeId={localNodeId}
          onClearChat={onClearChat}
          onDeleteMessage={onDeleteMessage}
          onRetryMessage={onRetryMessage}
        />
      </View>

      {/* Dedicated Chat Input Bar at Bottom */}
      <ChatInputBar
        selectedTargetId={targetId}
        selectedTargetName={headerTitle}
        onResetTargetToBroadcast={() => {}}
        onSendMessage={onSendMessage}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050811',
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#090D1A',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
    gap: 10,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingRight: 6,
    gap: 3,
  },
  backIcon: {
    fontSize: 20,
    fontWeight: '900',
    color: '#38BDF8',
  },
  backText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#38BDF8',
  },
  targetAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0F2038',
    borderWidth: 1,
    borderColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarInitial: {
    fontSize: 13,
    fontWeight: '900',
    color: '#38BDF8',
  },
  onlineDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 1.5,
    borderColor: '#090D1A',
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotAmber: {
    backgroundColor: '#F59E0B',
  },
  titleContainer: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 14.5,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.2,
  },
  headerSubtitle: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 1,
  },
  rightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  connectPill: {
    backgroundColor: '#0369A1',
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 5,
  },
  connectPillText: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  actionBtn: {
    padding: 4,
  },
  actionBtnText: {
    fontSize: 16,
  },
  presetStrip: {
    flexDirection: 'row',
    backgroundColor: '#0A0F1D',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
    gap: 6,
  },
  presetChip: {
    flex: 1,
    backgroundColor: '#111827',
    paddingVertical: 4.5,
    paddingHorizontal: 6,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0.8,
    borderColor: '#1E293B',
  },
  presetChipSos: {
    backgroundColor: '#380B0F',
    borderColor: '#EF4444',
  },
  presetChipText: {
    fontSize: 9.5,
    fontWeight: '700',
    color: '#94A3B8',
  },
  presetChipTextSos: {
    color: '#FCA5A5',
    fontWeight: '800',
  },
  feedWrapper: {
    flex: 1,
  },
});
