import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
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
}

export const ChannelBar: React.FC<ChannelBarProps> = ({
  activeTargetId,
  onSelectChannel,
  outboxCount = 0,
}) => {
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Preset Crisis Channels */}
        {CHANNELS.map((ch) => {
          const isSelected =
            (ch.id === '#all' && activeTargetId === 'BROADCAST') ||
            activeTargetId === ch.id;

          return (
            <TouchableOpacity
              key={ch.id}
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
    paddingVertical: 4.5,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  scrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 12,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    gap: 4.5,
  },
  chipIcon: {
    fontSize: 10.5,
  },
  chipLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#94A3B8',
  },
  chipLabelSelected: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  outboxBadgeWrap: {
    marginLeft: 4,
    justifyContent: 'center',
  },
  outboxBadge: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
  },
  outboxText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#FDE68A',
  },
});
