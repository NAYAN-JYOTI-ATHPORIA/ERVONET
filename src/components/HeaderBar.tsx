import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import { LocalNodeConfig } from '../services/storageService';
import { RadioState } from '../types/ble';

interface HeaderBarProps {
  localConfig: LocalNodeConfig;
  radioState: RadioState;
  onUpdateName: (name: string) => void;
  onOpenSettings: () => void;
  onEnableBluetooth?: () => void;
  onSendSos?: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  localConfig,
  radioState,
  onUpdateName,
  onOpenSettings,
  onEnableBluetooth,
  onSendSos,
}) => {
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [tempName, setTempName] = useState(localConfig.displayName || localConfig.name);

  const handleSosPress = () => {
    if (!onSendSos) return;
    Alert.alert(
      'Broadcast Emergency SOS?',
      'This broadcasts an immediate critical distress beacon to ALL nearby phones within Bluetooth reach.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send SOS Now',
          style: 'destructive',
          onPress: onSendSos,
        },
      ]
    );
  };

  const handleSaveName = () => {
    if (tempName.trim()) {
      onUpdateName(tempName.trim());
    }
    setNameModalVisible(false);
  };

  const isBluetoothOff = !radioState.isEnabled;
  const isConnected = radioState.connectedCount > 0;

  return (
    <View style={styles.container}>
      {/* Top Brand & Status */}
      <View style={styles.topRow}>
        <View style={styles.leftBrand}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>E</Text>
          </View>
          <View>
            <View style={styles.titleRow}>
              <Text style={styles.appTitle}>ERVONET</Text>
              <View style={styles.meshBadge}>
                <View style={styles.meshBadgeDot} />
                <Text style={styles.meshBadgeText}>OFFLINE</Text>
              </View>
            </View>
            <Text style={styles.appSubtitle} numberOfLines={1}>
              Emergency Relay Via Offline Nodes
            </Text>
            <TouchableOpacity
              style={styles.statusIndicator}
              onPress={isBluetoothOff && onEnableBluetooth ? onEnableBluetooth : undefined}
              disabled={!isBluetoothOff}
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.statusDot,
                  isBluetoothOff
                    ? styles.dotRed
                    : isConnected
                    ? styles.dotGreen
                    : styles.dotAmber,
                ]}
              />
              <Text
                style={[
                  styles.statusText,
                  isBluetoothOff && styles.statusTextAlert,
                ]}
              >
                {isBluetoothOff
                  ? 'Bluetooth is OFF • Tap to Enable'
                  : isConnected
                  ? `Active • ${radioState.connectedCount} peer(s) connected`
                  : 'Listening for nearby nodes...'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Right Action Buttons */}
        <View style={styles.rightActions}>
          {onSendSos && (
            <TouchableOpacity
              style={styles.sosHeaderBtn}
              onPress={handleSosPress}
              activeOpacity={0.8}
            >
              <Text style={styles.sosHeaderText}>SOS</Text>
            </TouchableOpacity>
          )}

          {/* User Name Chip */}
          <TouchableOpacity
            style={styles.userChip}
            onPress={() => {
              setTempName(localConfig.displayName || localConfig.name);
              setNameModalVisible(true);
            }}
            activeOpacity={0.7}
          >
            <View style={styles.userInitialCircle}>
              <Text style={styles.userInitialText}>
                {((localConfig.displayName || localConfig.name)[0] || 'U').toUpperCase()}
              </Text>
            </View>
            <View style={styles.userMetaCol}>
              <Text style={styles.userName} numberOfLines={1}>
                {localConfig.displayName || localConfig.name}
              </Text>
              <Text style={styles.userFixedId} numberOfLines={1}>
                {localConfig.deviceId || localConfig.nodeId}
              </Text>
            </View>
          </TouchableOpacity>

          {/* Settings / Controls Button */}
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={onOpenSettings}
            activeOpacity={0.7}
          >
            <View style={styles.menuIconBars}>
              <View style={styles.menuBar} />
              <View style={[styles.menuBar, { width: 9 }]} />
              <View style={styles.menuBar} />
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Edit Name Modal */}
      <Modal
        visible={nameModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setNameModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.nameModalCard}>
            <Text style={styles.modalTitle}>Set Your Name</Text>
            <Text style={styles.modalDesc}>
              This is how nearby people and rescue workers will identify you on ERVONET (Emergency Relay Via Offline Nodes).
            </Text>
            <View style={styles.fixedIdModalBox}>
              <Text style={styles.fixedIdModalLabel}>PERMANENT ERVONET DEVICE ID</Text>
              <Text style={styles.fixedIdModalVal}>
                {localConfig.deviceId || localConfig.nodeId}
              </Text>
            </View>
            <TextInput
              style={styles.nameInput}
              value={tempName}
              onChangeText={setTempName}
              placeholder="e.g. John Doe / Family of 3"
              placeholderTextColor="#64748B"
              maxLength={15}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setNameModalVisible(false)}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleSaveName}
              >
                <Text style={styles.saveBtnText}>Save Name</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  leftBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  brandMark: {
    width: 32,
    height: 32,
    borderRadius: 7,
    backgroundColor: '#0C2A44',
    borderWidth: 1.5,
    borderColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  brandMarkText: {
    fontSize: 18,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: -0.5,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  appTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: '#F8FAFC',
    letterSpacing: 0.6,
  },
  meshBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F2B48',
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
    borderWidth: 0.8,
    borderColor: '#0369A1',
    gap: 3.5,
  },
  meshBadgeDot: {
    width: 4.5,
    height: 4.5,
    borderRadius: 2.5,
    backgroundColor: '#10B981',
  },
  meshBadgeText: {
    fontSize: 7.5,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 0.6,
  },
  appSubtitle: {
    fontSize: 8.5,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 0.5,
    maxWidth: 165,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotAmber: {
    backgroundColor: '#F59E0B',
  },
  dotRed: {
    backgroundColor: '#EF4444',
  },
  statusText: {
    fontSize: 10,
    color: '#94A3B8',
    fontWeight: '500',
  },
  statusTextAlert: {
    color: '#F87171',
    fontWeight: '700',
  },
  rightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sosHeaderBtn: {
    backgroundColor: '#DC2626',
    paddingHorizontal: 8,
    paddingVertical: 4.5,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  sosHeaderText: {
    fontSize: 10.5,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  userChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1F2937',
    gap: 6,
    maxWidth: 145,
  },
  userInitialCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  userInitialText: {
    fontSize: 10,
    fontWeight: '900',
    color: '#38BDF8',
  },
  userMetaCol: {
    justifyContent: 'center',
    maxWidth: 95,
  },
  userName: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  userFixedId: {
    fontSize: 7.5,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.3,
  },
  settingsBtn: {
    backgroundColor: '#111827',
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  menuIconBars: {
    gap: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuBar: {
    width: 13,
    height: 1.5,
    backgroundColor: '#94A3B8',
    borderRadius: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  nameModalCard: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 340,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  modalDesc: {
    fontSize: 12,
    color: '#94A3B8',
    marginBottom: 16,
    lineHeight: 18,
  },
  fixedIdModalBox: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#0284C7',
    alignItems: 'center',
  },
  fixedIdModalLabel: {
    fontSize: 8.5,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  fixedIdModalVal: {
    fontSize: 15,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 1,
  },
  nameInput: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 18,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  cancelBtnText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  saveBtn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
