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
import { MessageRecord, MapSectorPayload } from '../types/message';
import { NetworkMetrics } from '../types/metrics';
import { LocalNodeConfig } from '../services/storageService';
import { EmergencyPreset } from '../protocol/emergencyAlerts';
import { locationService } from '../services/locationService';

type ActiveTab = 'MESH_MAP' | 'DEVICES';
type CurrentScreen = 'HUB' | 'CHAT';

export const MainScreen: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<CurrentScreen>('HUB');
  const [activeTab, setActiveTab] = useState<ActiveTab>('MESH_MAP');
  const [focusMapSector, setFocusMapSector] = useState<MapSectorPayload | null>(null);
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

    // Automatically ensure Advertising, Auto-Scan and Auto-Connect are ALWAYS ON
    bleService.ensureAlwaysOn().catch((e) => {
      console.warn('Ensure always on notice:', e);
    });

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
    try {
      await bleService.transmitMessage({
        targetId: selectedTargetId,
        payload: text,
        priority: 'NORMAL',
      });
      return true;
    } catch (e) {
      console.warn('Failed to transmit message:', e);
      return false;
    }
  };

  const handleSendPreset = async (preset: EmergencyPreset) => {
    try {
      let loc;
      let payload = preset.payload;

      if (preset.priority === 'CRITICAL_SOS' || preset.id === 'sos_help') {
        loc = await locationService.getCurrentLocation();
        if (loc) {
          payload += `\nGPS: ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
        }
      }

      await bleService.transmitMessage({
        targetId: selectedTargetId,
        payload,
        priority: preset.priority,
        location: loc
          ? {
              latitude: loc.latitude,
              longitude: loc.longitude,
              accuracy: loc.accuracy,
            }
          : undefined,
      });
    } catch (e) {
      console.warn('Failed to transmit preset:', e);
    }
  };

  const handleSendSos = async () => {
    try {
      // Acquire current GPS location
      const loc = await locationService.getCurrentLocation();

      let locationText = '';
      if (loc) {
        const latStr = loc.latitude.toFixed(5);
        const lngStr = loc.longitude.toFixed(5);
        const accStr = loc.accuracy ? ` (±${loc.accuracy}m)` : '';
        locationText = `\nGPS: ${latStr}, ${lngStr}${accStr}`;
      }

      await bleService.transmitMessage({
        targetId: 'BROADCAST', // SOS broadcasts to everyone
        payload: `[CRITICAL SOS]: Immediate assistance required at current coordinates!${locationText}`,
        priority: 'CRITICAL_SOS',
        location: loc
          ? {
              latitude: loc.latitude,
              longitude: loc.longitude,
              accuracy: loc.accuracy,
            }
          : undefined,
      });

      Alert.alert(
        'Emergency SOS Broadcasted',
        loc
          ? `Distress beacon with live GPS coordinates (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}) broadcast to all nearby phones over Bluetooth mesh.`
          : 'Emergency distress beacon broadcast to all nearby phones over Bluetooth mesh.'
      );
    } catch (e) {
      console.warn('Failed to broadcast SOS:', e);
    }
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

  const handleViewMapSector = (sector: MapSectorPayload) => {
    setFocusMapSector(sector);
    setCurrentScreen('HUB');
    setActiveTab('MESH_MAP');
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
          localConfig={localConfig}
          messages={messages}
          radioState={radioState}
          onBack={() => setCurrentScreen('HUB')}
          onSendMessage={handleSendTextMessage}
          onSendPreset={handleSendPreset}
          onClearChat={handleClearChat}
          onDeleteMessage={handleDeleteMessage}
          onRetryMessage={handleRetryMessage}
          onViewMapSector={handleViewMapSector}
          onConnectPeer={handleConnectPeer}
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
        <ScrollView
          style={styles.hubScroll}
          contentContainerStyle={styles.hubScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Cards for Everyone and Connected Users with Distance, Signal Strength & Factors */}
          <NearbyPeopleBar
            peers={peers}
            selectedTargetId={selectedTargetId}
            onSelectTarget={handleOpenChat}
            messages={messages}
          />

          {/* Crisis Channels (#all, SOS, #emergency, #medical, #supplies) */}
          <ChannelBar
            activeTargetId={selectedTargetId}
            onSelectChannel={handleOpenChat}
            outboxCount={outboxCount}
            onSendSos={handleSendSos}
          />

          {/* Real Offline Map with MapLibre, OpenFreeMap & Locally Downloaded Regions */}
          <OfflineMapLibre
            peers={peers}
            focusedSector={focusMapSector}
            onClearFocusedSector={() => setFocusMapSector(null)}
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
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
    gap: 8,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  tabButtonActive: {
    backgroundColor: '#0284C7',
    borderColor: '#38BDF8',
  },
  tabText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 0.2,
  },
  tabTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  tabWithBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tabBadge: {
    backgroundColor: '#38BDF8',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  tabBadgeText: {
    fontSize: 9.5,
    fontWeight: '900',
    color: '#0A1220',
  },
  hubScroll: {
    flex: 1,
  },
  hubScrollContent: {
    paddingBottom: 24,
  },
});
