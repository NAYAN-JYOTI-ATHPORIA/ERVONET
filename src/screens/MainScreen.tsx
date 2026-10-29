import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  StatusBar,
  SafeAreaView,
  Alert,
  TouchableOpacity,
  Text,
} from 'react-native';
import { HeaderBar } from '../components/HeaderBar';
import { QuickStatusBar } from '../components/QuickStatusBar';
import { ChannelBar } from '../components/ChannelBar';
import { NearbyPeopleBar } from '../components/NearbyPeopleBar';
import { ChatFeed } from '../components/ChatFeed';
import { ChatInputBar } from '../components/ChatInputBar';
import { ScannedDevicesSection } from '../components/ScannedDevicesSection';
import { SettingsModal } from '../components/SettingsModal';
import { CompulsoryUsernameModal } from '../components/CompulsoryUsernameModal';
import { bleService } from '../services/bleService';
import { bleBridge } from '../services/nativeBleBridge';
import { PeerNode, RadioState } from '../types/ble';
import { MessageRecord } from '../types/message';
import { NetworkMetrics } from '../types/metrics';
import { LocalNodeConfig } from '../services/storageService';
import { EmergencyPreset } from '../protocol/emergencyAlerts';

type ActiveTab = 'CHAT' | 'DEVICES';

export const MainScreen: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('CHAT');
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

  const handleSelectAndChat = (nodeId: string) => {
    setSelectedTargetId(nodeId);
    setActiveTab('CHAT');
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

  // Find human name of selected target
  const selectedPeer = peers.find(
    (p) =>
      p.id === selectedTargetId ||
      p.nodeId === selectedTargetId ||
      p.name === selectedTargetId
  );
  const targetDisplayName = selectedPeer ? selectedPeer.name : undefined;

  // Strict Segregation Filter:
  // Personal messages NEVER leak to Everyone; Everyone/Broadcast messages NEVER leak to Personal.
  const filteredMessages = messages.filter((m) => {
    // 1. Critical SOS distress alerts broadcast to all active views
    if (m.packet.priority === 'CRITICAL_SOS') {
      return true;
    }

    const isMessageBroadcast =
      m.packet.destinationId === 'BROADCAST' ||
      m.packet.destinationId === '#all';

    // 2. Everyone / Broadcast View
    if (selectedTargetId === 'BROADCAST' || selectedTargetId === '#all') {
      // ONLY broadcast messages appear in Everyone chat
      return isMessageBroadcast;
    }

    // 3. Preset Crisis Channels (#emergency, #medical, #supplies)
    if (selectedTargetId.startsWith('#')) {
      if (selectedTargetId === '#emergency') {
        return (
          m.packet.destinationId === '#emergency' ||
          m.packet.priority === 'URGENT' ||
          m.packet.payload.includes('[#EMERGENCY]')
        );
      }
      return (
        m.packet.destinationId === selectedTargetId ||
        m.packet.payload.includes(`[${selectedTargetId.toUpperCase()}]`)
      );
    }

    // 4. Direct 1-on-1 Personal Chat
    // Broadcast messages or channel messages MUST NEVER appear in 1-on-1 personal chat!
    if (isMessageBroadcast || m.packet.destinationId.startsWith('#')) {
      return false;
    }

    const peerAddress = selectedPeer?.id;
    const peerNodeId = selectedPeer?.nodeId || selectedTargetId;
    const peerName = selectedPeer?.name;

    const myNodeId = localConfig.deviceId || localConfig.nodeId;
    const myName = localConfig.displayName || localConfig.name;

    const matchesPeer = (id?: string, name?: string) => {
      if (!id && !name) return false;
      return (
        id === selectedTargetId ||
        id === peerNodeId ||
        (!!peerAddress && id === peerAddress) ||
        (!!peerName && (id === peerName || name === peerName))
      );
    };

    const matchesMe = (id?: string, name?: string) => {
      if (!id && !name) return false;
      return (
        id === myNodeId ||
        id === localConfig.nodeId ||
        (!!myName && (id === myName || name === myName))
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
    <View style={styles.safeArea}>
      {/* Top Header & Name */}
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
          style={[styles.tabButton, activeTab === 'CHAT' && styles.tabButtonActive]}
          onPress={() => setActiveTab('CHAT')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'CHAT' && styles.tabTextActive,
            ]}
          >
            Messages
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
      {activeTab === 'CHAT' ? (
        <View style={styles.chatTabContainer}>
          {/* Ultra-compact Emergency SOS & Quick Messages */}
          <QuickStatusBar
            onSendPreset={handleSendPreset}
            onSendSos={handleSendSos}
          />

          {/* Crisis Channels (#all, #emergency, #medical, #supplies) */}
          <ChannelBar
            activeTargetId={selectedTargetId}
            onSelectChannel={(ch) => setSelectedTargetId(ch)}
            outboxCount={outboxCount}
          />

          {/* Cards for Everyone and Connected Users with Distance, Signal Strength & Factors */}
          <NearbyPeopleBar
            peers={peers}
            selectedTargetId={selectedTargetId}
            onSelectTarget={setSelectedTargetId}
            messages={messages}
          />

          {/* Clean Chat Conversation Feed */}
          <ChatFeed
            messages={filteredMessages}
            localNodeId={localConfig.nodeId}
            onClearChat={handleClearChat}
            onDeleteMessage={handleDeleteMessage}
            onRetryMessage={handleRetryMessage}
          />

          {/* Bottom Chat Input Bar */}
          <ChatInputBar
            selectedTargetId={selectedTargetId}
            selectedTargetName={targetDisplayName}
            onResetTargetToBroadcast={() => setSelectedTargetId('BROADCAST')}
            onSendMessage={handleSendTextMessage}
          />
        </View>
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
  chatTabContainer: {
    flex: 1,
  },
});
