import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { bleBridge } from '../services/nativeBleBridge';

interface BluetoothRequiredModalProps {
  visible: boolean;
  onEnable?: () => void;
  onOpenSettings?: () => void;
}

export const BluetoothRequiredModal: React.FC<BluetoothRequiredModalProps> = ({
  visible,
  onEnable,
  onOpenSettings,
}) => {
  const [isRequesting, setIsRequesting] = useState<boolean>(false);

  const handleEnablePress = async () => {
    try {
      setIsRequesting(true);
      if (onEnable) {
        onEnable();
      } else {
        await bleBridge.enableBluetooth();
      }
    } catch (e) {
      console.warn('Bluetooth enable request error:', e);
    } finally {
      setTimeout(() => {
        setIsRequesting(false);
      }, 1500);
    }
  };

  const handleOpenSettingsPress = async () => {
    try {
      if (onOpenSettings) {
        onOpenSettings();
      } else {
        await bleBridge.openBluetoothSettings();
      }
    } catch (e) {
      console.warn('Bluetooth settings launch error:', e);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      statusBarTranslucent={true}
      onRequestClose={() => {
        // Enforce non-dismissible gate: Bluetooth is compulsory to operate ERVONET
      }}
    >
      <View style={styles.container}>
        <View style={styles.contentCard}>
          {/* Top Alert Badge */}
          <View style={styles.alertHeader}>
            <View style={styles.alertDot} />
            <Text style={styles.alertBadgeText}>CRITICAL RADIO STATUS</Text>
          </View>

          {/* Tactical Monogram / Emblem */}
          <View style={styles.emblemContainer}>
            <View style={styles.emblemRing}>
              <Text style={styles.emblemGlyph}>[!]</Text>
            </View>
          </View>

          {/* Title & Hierarchy */}
          <Text style={styles.title}>BLUETOOTH REQUIRED</Text>
          <Text style={styles.subtitle}>
            OFFLINE MESH RADIO INACTIVE
          </Text>

          {/* Explanation Body */}
          <View style={styles.infoBox}>
            <Text style={styles.bodyText}>
              ERVONET is an emergency peer-to-peer transmission system. All messages, distress SOS beacons, and tactical coordinates transmit directly across Bluetooth Low Energy without cellular towers or Wi-Fi.
            </Text>
            <Text style={styles.highlightText}>
              You cannot send or receive transmissions while Bluetooth is disabled.
            </Text>
          </View>

          {/* Real-time Status Indicator */}
          <View style={styles.statusRow}>
            <View style={styles.statusPulseRed} />
            <Text style={styles.statusLabel}>RADIO STATE: DISABLED (OFFLINE)</Text>
          </View>

          {/* Primary Action: Enable Bluetooth */}
          <TouchableOpacity
            style={[styles.primaryBtn, isRequesting && styles.btnDisabled]}
            onPress={handleEnablePress}
            activeOpacity={0.8}
            disabled={isRequesting}
          >
            {isRequesting ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>ENABLE BLUETOOTH NOW</Text>
            )}
          </TouchableOpacity>

          {/* Secondary Action: Open System Settings */}
          {Platform.OS === 'android' && (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={handleOpenSettingsPress}
              activeOpacity={0.7}
            >
              <Text style={styles.secondaryBtnText}>
                OPEN BLUETOOTH SETTINGS ➔
              </Text>
            </TouchableOpacity>
          )}

          <Text style={styles.footerNote}>
            Bluetooth will automatically activate the mesh and dismiss this screen as soon as the radio is enabled.
          </Text>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050811',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  contentCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#090D1A',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#7F1D1D',
    padding: 24,
    alignItems: 'center',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 10,
  },
  alertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#450A0A',
    borderColor: '#991B1B',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 7,
    marginBottom: 20,
  },
  alertDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#EF4444',
  },
  alertBadgeText: {
    fontSize: 10.5,
    fontWeight: '900',
    color: '#FCA5A5',
    letterSpacing: 0.8,
  },
  emblemContainer: {
    marginBottom: 16,
  },
  emblemRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1E1B2E',
    borderWidth: 2,
    borderColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emblemGlyph: {
    fontSize: 22,
    fontWeight: '900',
    color: '#EF4444',
    letterSpacing: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: '900',
    color: '#F8FAFC',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#EF4444',
    letterSpacing: 1.2,
    marginTop: 4,
    marginBottom: 16,
    textAlign: 'center',
  },
  infoBox: {
    backgroundColor: '#0C1322',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    width: '100%',
  },
  bodyText: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 18,
    textAlign: 'center',
    fontWeight: '500',
  },
  highlightText: {
    fontSize: 12,
    color: '#F8FAFC',
    fontWeight: '800',
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 17,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 20,
  },
  statusPulseRed: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#EF4444',
    letterSpacing: 0.6,
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
    marginBottom: 10,
  },
  primaryBtnText: {
    fontSize: 13,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.6,
  },
  secondaryBtn: {
    width: '100%',
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  secondaryBtnText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  footerNote: {
    fontSize: 10,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 14,
    paddingHorizontal: 8,
  },
});

