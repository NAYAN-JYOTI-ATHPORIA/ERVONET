import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
} from 'react-native';
import { PeerNode } from '../types/ble';
import { MessagePriority } from '../types/message';
import { EMERGENCY_PRESETS, EmergencyPreset } from '../protocol/emergencyAlerts';

interface MessageTransmitterProps {
  peers: PeerNode[];
  selectedTargetId: string;
  onSelectTarget: (targetId: string) => void;
  onTransmit: (params: {
    targetId: string;
    payload: string;
    priority: MessagePriority;
    ttl: number;
  }) => Promise<boolean>;
}

export const MessageTransmitter: React.FC<MessageTransmitterProps> = ({
  peers,
  selectedTargetId,
  onSelectTarget,
  onTransmit,
}) => {
  const [messageText, setMessageText] = useState('');
  const [priority, setPriority] = useState<MessagePriority>('NORMAL');
  const [ttl, setTtl] = useState<number>(3);
  const [isSending, setIsSending] = useState(false);

  const connectedPeers = peers.filter((p) => p.connectionState === 'CONNECTED');

  const handleSelectPreset = (preset: EmergencyPreset) => {
    setMessageText(preset.payload);
    setPriority(preset.priority);
  };

  const handleSend = async () => {
    const trimmed = messageText.trim();
    if (!trimmed) {
      Alert.alert('Empty Message', 'Please enter a message or select a preset alert.');
      return;
    }

    setIsSending(true);
    try {
      await onTransmit({
        targetId: selectedTargetId,
        payload: trimmed,
        priority,
        ttl,
      });
      setMessageText('');
    } catch (e: any) {
      Alert.alert('Transmission Failed', e.message || 'Error sending packet.');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>TRANSMIT OFFLINE PACKET</Text>
        <Text style={styles.headerSub}>
          {connectedPeers.length} Active BLE Links
        </Text>
      </View>

      {/* Target Selector Bar */}
      <View style={styles.selectorGroup}>
        <Text style={styles.fieldLabel}>DESTINATION TARGET:</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.targetsRow}
        >
          <TouchableOpacity
            style={[
              styles.targetChip,
              selectedTargetId === 'BROADCAST' && styles.targetChipActive,
            ]}
            onPress={() => onSelectTarget('BROADCAST')}
          >
            <Text
              style={[
                styles.targetChipText,
                selectedTargetId === 'BROADCAST' && styles.targetChipTextActive,
              ]}
            >
              📢 ALL NEARBY (BROADCAST)
            </Text>
          </TouchableOpacity>

          {peers.map((peer) => {
            const isTarget =
              selectedTargetId === peer.id || selectedTargetId === peer.nodeId;
            const isConn = peer.connectionState === 'CONNECTED';
            return (
              <TouchableOpacity
                key={peer.id}
                style={[
                  styles.targetChip,
                  isTarget && styles.targetChipActive,
                  !isConn && styles.targetChipUnconnected,
                ]}
                onPress={() => onSelectTarget(peer.nodeId)}
              >
                <Text
                  style={[
                    styles.targetChipText,
                    isTarget && styles.targetChipTextActive,
                  ]}
                >
                  {isConn ? '🟢' : '⚪'} {peer.nodeId}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Priority Level Selector */}
      <View style={styles.priorityRow}>
        <TouchableOpacity
          style={[
            styles.priorityBtn,
            priority === 'NORMAL' && styles.priorityBtnNormalActive,
          ]}
          onPress={() => setPriority('NORMAL')}
        >
          <Text
            style={[
              styles.priorityText,
              priority === 'NORMAL' && styles.priorityTextActive,
            ]}
          >
            NORMAL
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.priorityBtn,
            priority === 'URGENT' && styles.priorityBtnUrgentActive,
          ]}
          onPress={() => setPriority('URGENT')}
        >
          <Text
            style={[
              styles.priorityText,
              priority === 'URGENT' && styles.priorityTextUrgentActive,
            ]}
          >
            ⚠️ URGENT
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.priorityBtn,
            priority === 'CRITICAL_SOS' && styles.priorityBtnSosActive,
          ]}
          onPress={() => setPriority('CRITICAL_SOS')}
        >
          <Text
            style={[
              styles.priorityText,
              priority === 'CRITICAL_SOS' && styles.priorityTextSosActive,
            ]}
          >
            🚨 SOS / CRITICAL
          </Text>
        </TouchableOpacity>
      </View>

      {/* Emergency Preset Quick Buttons */}
      <View style={styles.presetsSection}>
        <Text style={styles.fieldLabel}>QUICK HAZARD PRESETS (DIGESTER / PLANT):</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.presetsRow}
        >
          {EMERGENCY_PRESETS.map((preset: EmergencyPreset) => (
            <TouchableOpacity
              key={preset.id}
              style={[
                styles.presetPill,
                preset.priority === 'CRITICAL_SOS' && styles.presetCritical,
                preset.priority === 'URGENT' && styles.presetHazard,
              ]}
              onPress={() => handleSelectPreset(preset)}
            >
              <Text style={styles.presetText}>{preset.title}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Message Input Box */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.textInput}
          placeholder="Compose safety message or tap preset above..."
          placeholderTextColor="#64748B"
          value={messageText}
          onChangeText={setMessageText}
          multiline
          maxLength={300}
        />
        <View style={styles.inputFooter}>
          {/* TTL Selector */}
          <View style={styles.ttlSelector}>
            <Text style={styles.ttlLabel}>TTL / Hops:</Text>
            {[1, 2, 3, 5].map((hop) => (
              <TouchableOpacity
                key={hop}
                style={[styles.ttlChip, ttl === hop && styles.ttlChipActive]}
                onPress={() => setTtl(hop)}
              >
                <Text
                  style={[
                    styles.ttlChipText,
                    ttl === hop && styles.ttlChipTextActive,
                  ]}
                >
                  {hop}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.charCounter}>{messageText.length}/300</Text>
        </View>
      </View>

      {/* Transmission Button */}
      <TouchableOpacity
        style={[
          styles.transmitBtn,
          priority === 'CRITICAL_SOS' && styles.transmitBtnSos,
          isSending && styles.transmitBtnDisabled,
        ]}
        onPress={handleSend}
        disabled={isSending}
        activeOpacity={0.8}
      >
        <Text style={styles.transmitIcon}>{isSending ? '⏳' : '⚡'}</Text>
        <Text style={styles.transmitBtnText}>
          {isSending
            ? 'TRANSMITTING OVER BLE...'
            : `TRANSMIT PACKET → ${selectedTargetId}`}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0F172A',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  headerSub: {
    fontSize: 11,
    color: '#10B981',
    fontWeight: '600',
  },
  selectorGroup: {
    marginBottom: 10,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  targetsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  targetChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  targetChipActive: {
    backgroundColor: '#0284C7',
    borderColor: '#38BDF8',
  },
  targetChipUnconnected: {
    opacity: 0.6,
  },
  targetChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
  },
  targetChipTextActive: {
    color: '#FFFFFF',
  },
  priorityRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  priorityBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#1E293B',
    alignItems: 'center',
  },
  priorityBtnNormalActive: {
    backgroundColor: '#0369A1',
    borderColor: '#38BDF8',
  },
  priorityBtnUrgentActive: {
    backgroundColor: '#B45309',
    borderColor: '#F59E0B',
  },
  priorityBtnSosActive: {
    backgroundColor: '#B91C1C',
    borderColor: '#EF4444',
  },
  priorityText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#94A3B8',
  },
  priorityTextActive: {
    color: '#FFFFFF',
  },
  priorityTextUrgentActive: {
    color: '#FEF3C7',
  },
  priorityTextSosActive: {
    color: '#FFFFFF',
  },
  presetsSection: {
    marginBottom: 10,
  },
  presetsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  presetPill: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  presetCritical: {
    borderColor: '#EF4444',
    backgroundColor: '#450A0A',
  },
  presetHazard: {
    borderColor: '#F59E0B',
    backgroundColor: '#451A03',
  },
  presetRescue: {
    borderColor: '#38BDF8',
    backgroundColor: '#082F49',
  },
  presetText: {
    fontSize: 11,
    color: '#E2E8F0',
    fontWeight: '600',
  },
  inputContainer: {
    backgroundColor: '#1E293B',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  textInput: {
    color: '#F8FAFC',
    fontSize: 13,
    minHeight: 50,
    textAlignVertical: 'top',
    padding: 0,
  },
  inputFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  ttlSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ttlLabel: {
    fontSize: 10,
    color: '#94A3B8',
    marginRight: 4,
  },
  ttlChip: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#0F172A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ttlChipActive: {
    backgroundColor: '#0284C7',
  },
  ttlChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
  },
  ttlChipTextActive: {
    color: '#FFFFFF',
  },
  charCounter: {
    fontSize: 10,
    color: '#64748B',
  },
  transmitBtn: {
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  transmitBtnSos: {
    backgroundColor: '#DC2626',
  },
  transmitBtnDisabled: {
    opacity: 0.6,
  },
  transmitIcon: {
    fontSize: 16,
  },
  transmitBtnText: {
    fontSize: 13,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});

