import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  ScrollView,
  Alert,
} from 'react-native';
import { HeaderBar } from '../components/HeaderBar';
import { QuickStatusBar } from '../components/QuickStatusBar';
import { ChannelBar } from '../components/ChannelBar';
import { NearbyPeopleBar } from '../components/NearbyPeopleBar';
import { ScannedDevicesSection } from '../components/ScannedDevicesSection';
import { SettingsModal } from '../components/SettingsModal';
import { CompulsoryUsernameModal } from '../components/CompulsoryUsernameModal';
import { ChatScreen } from './ChatScreen';
import { bleService } from '../services/bleService';
import { bleBridge } from '../services/nativeBleBridge';
import { PeerNode, RadioState } from '../types/ble';
import { MessageRecord } from '../types/message';
import { NetworkMetrics } from '../types/metrics';
import { LocalNodeConfig } from '../services/storageService';
import { EmergencyPreset } from '../protocol/emergencyAlerts';
import { formatTime } from '../utils/formatters';
import { getSignalQuality, estimateDistanceMeters } from '../utils/distance';

type ActiveTab = 'CONVERSATIONS' | 'DEVICES';
type CurrentScreen = 'HUB' | 'CHAT';

export const MainScreen: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<CurrentScreen>('HUB');
  const [activeTab, setActiveTab] = useState<ActiveTab>('CONVERSATIONS');
  const [radioState, setRadioState] = useState<RadioState>(
    bleService.getStateSnapshot().radioState
  );
  const [peers, setPeers] = useState<PeerNode[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [metrics, setMetrics] = useState<NetworkMetrics>(
    bleService.getStateSnapshot().metrics
  );
  const [localConfig, setLocalConfig] = useState<LocalNodeConfig>(
    bleService.getStateSnapshot().localConfig
  );
  const [outboxCount, setOutboxCount] = useState<number>(
    bleService.getStateSnapshot().outboxCount
  );

  const [selectedTargetId, setSelectedTargetId] = useState<string>('BROADCAST');
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);

  useEffect(() => {
    // Subscribe to BLE service state
    const unsubscribe = bleService.subscribe((state) => {
      setRadioState(state.radioState);
      setPeers(state.peers);
      setMessages(state.messages);
      setMetrics(state.metrics);
      setLocalConfig(state.localConfig);
      setOutboxCount(state.outboxCount);
    });

    // Automatically enable Auto-Scan and Advertising for seamless background discovery
    const autoStart = async () => {
      try {
        await bleService.toggleAutoScan();
        await bleService.toggleAdvertising();
      } catch (e) {
        console.warn('Auto start notice:', e);
      }
    };
    autoStart();

    return () => {
      unsubscribe();
    };
  }, []);

  const handleUpdateName = (name: string) => {
    bleService.setDisplayName(name);
  };

  const handleSaveCompulsoryUsername = async (username: string) => {
    await bleService.saveCompulsoryUsername(username);
  };

  const handleToggleMode = () => {
    const nextMode =
      radioState.operatingMode === 'SIMULATION_TESTBED'
        ? 'NATIVE_BLE'
        : 'SIMULATION_TESTBED';
    bleService.setOperatingMode(nextMode);
  };

  const handleToggleScan = () => {
    bleService.toggleAutoScan();
  };

  const handleToggleAdvertising = () => {
    bleService.toggleAdvertising();
  };

  const handleToggleAutoConnect = (enabled: boolean) => {
    bleService.setAutoConnect(enabled);
  };

  const handleConnectPeer = (address: string) => {
    bleService.connectToPeer(address);
  };

  const handleDisconnectPeer = (address: string) => {
    bleService.disconnectPeer(address);
  };

  // Opens the dedicated, uncluttered full-screen Chat Page
  const handleOpenChat = (targetId: string) => {
    setSelectedTargetId(targetId);
    setCurrentScreen('CHAT');
  };

  const handleSelectAndChat = (nodeId: string) => {
    handleOpenChat(nodeId);
  };

  const handleSendTextMessage = async (text: string): Promise<boolean> => {
    return await bleService.transmitMessage({
      targetId: selectedTargetId,
      payload: text,
      priority: 'NORMAL',
    });
  };

  const handleSendPreset = async (preset: EmergencyPreset) => {
    await bleService.transmitMessage({
      targetId: selectedTargetId,
      payload: preset.payload,
      priority: preset.priority,
    });
  };

  const handleSendSos = async () => {
    await bleService.transmitMessage({
      targetId: 'BROADCAST', // SOS broadcasts to everyone
      payload: 'SOS EMERGENCY: I need immediate help at my current location!',
      priority: 'CRITICAL_SOS',
    });
    Alert.alert(
      'SOS Transmitted',
      'Your emergency distress alert has been broadcast to all nearby phones over Bluetooth.'
    );
  };

  const handleClearChat = () => {
    bleService.clearMessages(selectedTargetId);
  };

  const handleDeleteMessage = (messageId: string) => {
    bleService.deleteMessage(messageId);
  };

  const handleRetryMessage = async (messageId: string) => {
    const success = await bleService.retryMessage(messageId);
    if (!success) {
      Alert.alert(
        'DTN Outbox Retention',
        'Direct connection to the target device is currently unavailable. The message is retained in the ERVONET Store-and-Forward Outbox and will be dispatched as soon as a mesh node is in proximity.'
      );
    }
  };

  // Find human name / details of selected target
  const selectedPeer = peers.find(
    (p) =>
      p.id === selectedTargetId ||
      p.nodeId === selectedTargetId ||
      p.name === selectedTargetId
  );

  // Helper to extract the last message for a peer
  const getLastMessageForPeer = (peer: PeerNode) => {
    const peerMsgs = messages.filter((m) => {
      if (m.packet.priority === 'CRITICAL_SOS') return false;
      const isBroadcast =
        m.packet.destinationId === 'BROADCAST' ||
        m.packet.destinationId === '#all' ||
        m.packet.destinationId.startsWith('#');
      if (isBroadcast) return false;

      return (
        m.packet.destinationId === peer.nodeId ||
        m.packet.destinationId === peer.id ||
        m.packet.senderId === peer.nodeId ||
        m.packet.senderId === peer.id ||
        (!!peer.name &&
          (m.packet.senderName === peer.name ||
            m.packet.destinationId === peer.name))
      );
    });
    return peerMsgs.length > 0 ? peerMsgs[peerMsgs.length - 1] : null;
  };

  const latestBroadcastMsg = messages
    .filter(
      (m) =>
        m.packet.destinationId === 'BROADCAST' ||
        m.packet.destinationId === '#all'
    )
    .slice(-1)[0];

  // -------------------------------------------------------------
  // DEDICATED FULL-SCREEN CHAT PAGE
  // -------------------------------------------------------------
  if (currentScreen === 'CHAT') {
    return (
      <View style={styles.safeArea}>
        <ChatScreen
          targetId={selectedTargetId}
          peer={selectedPeer}
          localNodeId={localConfig.nodeId}
          localConfig={localConfig}
          messages={messages}
          radioState={radioState}
          onBack={() => setCurrentScreen('HUB')}
          onSendMessage={handleSendTextMessage}
          onSendPreset={handleSendPreset}
          onClearChat={handleClearChat}
          onDeleteMessage={handleDeleteMessage}
          onRetryMessage={handleRetryMessage}
          onConnectPeer={handleConnectPeer}
          onDisconnectPeer={handleDisconnectPeer}
        />

        {/* Compulsory Mandatory Username Setup Gate on Install / Launch */}
        <CompulsoryUsernameModal
          visible={!localConfig.hasConfiguredUsername}
          deviceId={localConfig.deviceId || localConfig.nodeId}
          onSave={handleSaveCompulsoryUsername}
        />
      </View>
    );
  }

  // -------------------------------------------------------------
  // MAIN HUB SCREEN: People & Everyone Cards, Channels & Conversations
  // -------------------------------------------------------------
  return (
    <View style={styles.safeArea}>
      {/* Top Header & Settings */}
      <HeaderBar
        localConfig={localConfig}
        radioState={radioState}
        onUpdateName={handleUpdateName}
        onOpenSettings={() => setShowSettingsModal(true)}
        onEnableBluetooth={() => bleBridge.enableBluetooth()}
      />

      {/* Clean Segmented Navigation Tab */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === 'CONVERSATIONS' && styles.tabButtonActive,
          ]}
          onPress={() => setActiveTab('CONVERSATIONS')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'CONVERSATIONS' && styles.tabTextActive,
            ]}
          >
            Conversations & Mesh
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === 'DEVICES' && styles.tabButtonActive,
          ]}
          onPress={() => setActiveTab('DEVICES')}
          activeOpacity={0.7}
        >
          <View style={styles.tabWithBadge}>
            <Text
              style={[
                styles.tabText,
                activeTab === 'DEVICES' && styles.tabTextActive,
              ]}
            >
              Nearby Devices
            </Text>
            {peers.length > 0 && (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{peers.length}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>

      {/* Main Tab Content */}
      {activeTab === 'CONVERSATIONS' ? (
        <ScrollView style={styles.hubScroll} showsVerticalScrollIndicator={false}>
          {/* Ultra-compact Emergency SOS Distress & Presets */}
          <QuickStatusBar
            onSendPreset={handleSendPreset}
            onSendSos={handleSendSos}
          />

          {/* Cards for Everyone and Connected Users with Distance, Signal Strength & Factors */}
          <NearbyPeopleBar
            peers={peers}
            selectedTargetId={selectedTargetId}
            onSelectTarget={handleOpenChat}
            messages={messages}
          />

          {/* Crisis Channels (#all, #emergency, #medical, #supplies) */}
          <ChannelBar
            activeTargetId={selectedTargetId}
            onSelectChannel={handleOpenChat}
            outboxCount={outboxCount}
          />

          {/* Open Conversations Section */}
          <View style={styles.conversationsContainer}>
            <View style={styles.convHeaderRow}>
              <Text style={styles.convHeaderTitle}>OFFLINE CHATS</Text>
              <Text style={styles.convHeaderSub}>
                Tap any card to open dedicated chat
              </Text>
            </View>

            {/* Conversation 1: Everyone (Broadcast) */}
            <TouchableOpacity
              style={styles.convCard}
              onPress={() => handleOpenChat('BROADCAST')}
              activeOpacity={0.75}
            >
              <View style={[styles.convAvatar, styles.convAvatarBroadcast]}>
                <Text style={styles.convAvatarText}>ALL</Text>
              </View>
              <View style={styles.convContent}>
                <View style={styles.convTopRow}>
                  <Text style={styles.convTitle}>Everyone (Broadcast)</Text>
                  {latestBroadcastMsg && (
                    <Text style={styles.convTime}>
                      {formatTime(latestBroadcastMsg.packet.timestamp)}
                    </Text>
                  )}
                </View>
                <Text style={styles.convSnippet} numberOfLines={1}>
                  {latestBroadcastMsg
                    ? `${
                        latestBroadcastMsg.direction === 'OUTGOING'
                          ? 'You: '
                          : (latestBroadcastMsg.packet.senderName ||
                              latestBroadcastMsg.packet.senderId) + ': '
                      }${latestBroadcastMsg.packet.payload}`
                    : 'Tap to open broadcast chat with all nearby nodes...'}
                </Text>
              </View>
              <View style={styles.convArrowWrap}>
                <Text style={styles.convArrow}>Chat ➔</Text>
              </View>
            </TouchableOpacity>

            {/* Conversation Cards for Nearby Discovered/Connected Users */}
            {peers.map((peer) => {
              const peerName = peer.name || peer.nodeId;
              const isConnected = peer.connectionState === 'CONNECTED';
              const estimatedMeters = peer.rssi ? estimateDistanceMeters(peer.rssi) : null;
              const distText = estimatedMeters ? `~${estimatedMeters}m` : 'Nearby';
              const lastPeerMsg = getLastMessageForPeer(peer);

              return (
                <TouchableOpacity
                  key={peer.id}
                  style={styles.convCard}
                  onPress={() => handleOpenChat(peer.nodeId || peer.id)}
                  activeOpacity={0.75}
                >
                  <View style={styles.convAvatar}>
                    <Text style={styles.convAvatarText}>
                      {(peerName[0] || 'U').toUpperCase()}
                    </Text>
                    <View
                      style={[
                        styles.convStatusDot,
                        isConnected ? styles.dotGreen : styles.dotAmber,
                      ]}
                    />
                  </View>
                  <View style={styles.convContent}>
                    <View style={styles.convTopRow}>
                      <View style={styles.convNameGroup}>
                        <Text style={styles.convTitle} numberOfLines={1}>
                          {peerName}
                        </Text>
                        <Text style={styles.convChip}>{peer.nodeId}</Text>
                      </View>
                      {lastPeerMsg && (
                        <Text style={styles.convTime}>
                          {formatTime(lastPeerMsg.packet.timestamp)}
                        </Text>
                      )}
                    </View>
                    <Text style={styles.convSnippet} numberOfLines={1}>
                      {lastPeerMsg
                        ? `${
                            lastPeerMsg.direction === 'OUTGOING' ? 'You: ' : ''
                          }${lastPeerMsg.packet.payload}`
                        : `${distText} • ${peer.rssi || -75} dBm • ${
                            isConnected ? 'Connected' : 'In Range'
                          }`}
                    </Text>
                  </View>
                  <View style={styles.convArrowWrap}>
                    <Text style={styles.convArrow}>Chat ➔</Text>
                  </View>
                </TouchableOpacity>
              );
            })}

            {/* Empty state hint if no peers discovered yet */}
            {peers.length === 0 && (
              <View style={styles.hubEmptyBox}>
                <Text style={styles.hubEmptyTitle}>
                  Listening for Nearby ERVONET Nodes
                </Text>
                <Text style={styles.hubEmptySubtitle}>
                  Bring another Android phone running ERVONET within Bluetooth range (~30m). Devices discover each other automatically without internet.
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        /* Dedicated Scanned Devices Section */
        <ScannedDevicesSection
          peers={peers}
          isScanning={radioState.isScanning}
          selectedTargetId={selectedTargetId}
          onSelectAndChat={handleSelectAndChat}
          onConnectPeer={handleConnectPeer}
          onDisconnectPeer={handleDisconnectPeer}
          onToggleScan={handleToggleScan}
        />
      )}

      {/* Research Settings & Diagnostic Modal */}
      <SettingsModal
        visible={showSettingsModal}
        radioState={radioState}
        metrics={metrics}
        onToggleMode={handleToggleMode}
        onToggleScan={handleToggleScan}
        onToggleAdvertising={handleToggleAdvertising}
        onToggleAutoConnect={handleToggleAutoConnect}
        onWipeData={() => bleService.wipeAllData()}
        onClose={() => setShowSettingsModal(false)}
      />

      {/* Compulsory Mandatory Username Setup Gate on Install / Launch */}
      <CompulsoryUsernameModal
        visible={!localConfig.hasConfiguredUsername}
        deviceId={localConfig.deviceId || localConfig.nodeId}
        onSave={handleSaveCompulsoryUsername}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#050811',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#090D1A',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
    gap: 6,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: '#111827',
  },
  tabButtonActive: {
    backgroundColor: '#0284C7',
  },
  tabText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
  },
  tabTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  tabWithBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  tabBadge: {
    backgroundColor: '#38BDF8',
    paddingHorizontal: 5,
    paddingVertical: 0.5,
    borderRadius: 6,
  },
  tabBadgeText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#0F172A',
  },
  hubScroll: {
    flex: 1,
  },
  conversationsContainer: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 24,
  },
  convHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  convHeaderTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.8,
  },
  convHeaderSub: {
    fontSize: 9.5,
    fontWeight: '600',
    color: '#475569',
  },
  convCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0A0F1D',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#162032',
    gap: 12,
  },
  convAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0F1E36',
    borderWidth: 1,
    borderColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  convAvatarBroadcast: {
    borderColor: '#38BDF8',
    backgroundColor: '#0C2A44',
  },
  convAvatarText: {
    fontSize: 13,
    fontWeight: '900',
    color: '#38BDF8',
  },
  convStatusDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 1.5,
    borderColor: '#0A0F1D',
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotAmber: {
    backgroundColor: '#F59E0B',
  },
  convContent: {
    flex: 1,
  },
  convTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  convNameGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  convTitle: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  convChip: {
    fontSize: 9,
    fontWeight: '700',
    color: '#38BDF8',
    backgroundColor: '#0F1E36',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  convTime: {
    fontSize: 9.5,
    fontWeight: '600',
    color: '#64748B',
  },
  convSnippet: {
    fontSize: 11.5,
    color: '#94A3B8',
    lineHeight: 16,
  },
  convArrowWrap: {
    paddingLeft: 4,
  },
  convArrow: {
    fontSize: 11,
    fontWeight: '800',
    color: '#38BDF8',
  },
  hubEmptyBox: {
    backgroundColor: '#0A0F1D',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#162032',
    padding: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  hubEmptyTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#E2E8F0',
    marginBottom: 4,
  },
  hubEmptySubtitle: {
    fontSize: 11,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 16,
  },
});
