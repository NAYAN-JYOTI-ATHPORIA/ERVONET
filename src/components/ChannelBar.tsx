import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';

export interface ChannelItem {
  id: string; // e.g. '#all', '#emergency', '#medical', '#supplies'
  label: string;
  icon: string;
  color: string;
}

const CHANNELS: ChannelItem[] = [
  { id: '#all', label: 'All Nearby', icon: '#', color: '#0284C7' },
  { id: '#emergency', label: 'Emergency', icon: '!', color: '#EF4444' },
  { id: '#medical', label: 'Medical', icon: '+', color: '#10B981' },
  { id: '#supplies', label: 'Supplies', icon: '=', color: '#F59E0B' },
];

interface ChannelBarProps {
  activeTargetId: string;
  onSelectChannel: (targetId: string) => void;
  outboxCount?: number;
  onSendSos?: () => void;
}

export const ChannelBar: React.FC<ChannelBarProps> = ({
  activeTargetId,
  onSelectChannel,
  outboxCount = 0,
  onSendSos,
}) => {
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

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Preset Crisis Channels & SOS Distress Trigger */}
        {CHANNELS.map((ch) => {
          const isSelected =
            (ch.id === '#all' && activeTargetId === 'BROADCAST') ||
            activeTargetId === ch.id;

          const isEmergency = ch.id === '#emergency';

          return (
            <React.Fragment key={ch.id}>
              {isEmergency && onSendSos && (
                <TouchableOpacity
                  style={styles.sosChip}
                  onPress={handleSosPress}
                  activeOpacity={0.75}
                >
                  <View style={styles.sosDot} />
                  <Text style={styles.sosChipText}>SOS BEACON</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[
                  styles.chip,
                  isSelected && {
                    borderColor: ch.color,
                    backgroundColor: `${ch.color}24`,
                  },
                ]}
                onPress={() =>
                  onSelectChannel(ch.id === '#all' ? 'BROADCAST' : ch.id)
                }
                activeOpacity={0.7}
              >
                <Text style={styles.chipIcon}>{ch.icon}</Text>
                <Text
                  style={[
                    styles.chipLabel,
                    isSelected && styles.chipLabelSelected,
                  ]}
                >
                  {ch.label}
                </Text>
              </TouchableOpacity>
            </React.Fragment>
          );
        })}

        {/* Outbox Badge if Pending Queue Exists */}
        {outboxCount > 0 && (
          <View style={styles.outboxBadgeWrap}>
            <View style={styles.outboxBadge}>
              <Text style={styles.outboxText}>{outboxCount} Outbox</Text>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  scrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#1E293B',
    gap: 5,
  },
  chipIcon: {
    fontSize: 11,
  },
  chipLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
  },
  chipLabelSelected: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  sosChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7F1D1D',
    borderWidth: 1.5,
    borderColor: '#EF4444',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    gap: 6,
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 3,
  },
  sosDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#FCA5A5',
  },
  sosChipText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#FEE2E2',
    letterSpacing: 0.5,
  },
  outboxBadgeWrap: {
    marginLeft: 4,
    justifyContent: 'center',
  },
  outboxBadge: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  outboxText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#FDE68A',
  },
});
