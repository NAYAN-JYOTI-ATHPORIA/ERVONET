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
import { OfflineMapLibre } from '../components/OfflineMapLibre';
import { ChatScreen } from './ChatScreen';
import { bleService } from '../services/bleService';
import { bleBridge } from '../services/nativeBleBridge';
import { PeerNode, RadioState } from '../types/ble';
import { MessageRecord } from '../types/message';
import { NetworkMetrics } from '../types/metrics';
import { LocalNodeConfig } from '../services/storageService';
import { EmergencyPreset } from '../protocol/emergencyAlerts';

type ActiveTab = 'MESH_MAP' | 'DEVICES';
type CurrentScreen = 'HUB' | 'CHAT';

export const MainScreen: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<CurrentScreen>('HUB');
  const [activeTab, setActiveTab] = useState<ActiveTab>('MESH_MAP');
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
            activeTab === 'MESH_MAP' && styles.tabButtonActive,
          ]}
          onPress={() => setActiveTab('MESH_MAP')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'MESH_MAP' && styles.tabTextActive,
            ]}
          >
            Offline Map & Hub
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
      {activeTab === 'MESH_MAP' ? (
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

          {/* Real Offline Map with MapLibre, OpenFreeMap & Locally Downloaded Regions */}
          <OfflineMapLibre
            localNodeId={localConfig.deviceId || localConfig.nodeId}
            localName={localConfig.displayName || localConfig.name}
            peers={peers}
            onOpenChat={handleOpenChat}
            onConnectPeer={handleConnectPeer}
          />
        </ScrollView>
      ) : (
        /* Dedicated Scanned Devices Section with Shifted Radar Map */
        <ScannedDevicesSection
          peers={peers}
          isScanning={radioState.isScanning}
          selectedTargetId={selectedTargetId}
          onSelectAndChat={handleSelectAndChat}
          onConnectPeer={handleConnectPeer}
          onDisconnectPeer={handleDisconnectPeer}
          onToggleScan={handleToggleScan}
          localNodeId={localConfig.deviceId || localConfig.nodeId}
          localName={localConfig.displayName || localConfig.name}
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
});
