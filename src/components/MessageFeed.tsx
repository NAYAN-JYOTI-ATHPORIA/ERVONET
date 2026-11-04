import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { MessageRecord } from '../types/message';
import { formatTime, formatTimeAgo } from '../utils/formatters';

interface MessageFeedProps {
  messages: MessageRecord[];
  localNodeId: string;
}

export const MessageFeed: React.FC<MessageFeedProps> = ({
  messages,
  localNodeId,
}) => {
  const [filter, setFilter] = useState<'ALL' | 'ALERTS' | 'DIRECT'>('ALL');

  const filteredMessages = messages.filter((msg) => {
    if (filter === 'ALERTS') {
      return (
        msg.packet.priority === 'CRITICAL_SOS' ||
        msg.packet.priority === 'URGENT' ||
        msg.packet.messageType === 'ALERT'
      );
    }
    if (filter === 'DIRECT') {
      return msg.packet.destinationId !== 'BROADCAST';
    }
    return true;
  });

  return (
    <View style={styles.container}>
      {/* Section Header & Tabs */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.sectionTitle}>TRANSMISSION LOG & RECEPTION</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{messages.length}</Text>
          </View>
        </View>

        {/* Filter Pills */}
        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tab, filter === 'ALL' && styles.tabActive]}
            onPress={() => setFilter('ALL')}
          >
            <Text
              style={[
                styles.tabText,
                filter === 'ALL' && styles.tabTextActive,
              ]}
            >
              All
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, filter === 'ALERTS' && styles.tabActive]}
            onPress={() => setFilter('ALERTS')}
          >
            <Text
              style={[
                styles.tabText,
                filter === 'ALERTS' && styles.tabTextActive,
              ]}
            >
              🚨 Alerts
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, filter === 'DIRECT' && styles.tabActive]}
            onPress={() => setFilter('DIRECT')}
          >
            <Text
              style={[
                styles.tabText,
                filter === 'DIRECT' && styles.tabTextActive,
              ]}
            >
              Direct
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Messages List */}
      {filteredMessages.length === 0 ? (
        <View style={styles.emptyFeed}>
          <Text style={styles.emptyFeedText}>
            No messages recorded in this filter.
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.messagesList} nestedScrollEnabled>
          {filteredMessages.map((record) => {
            const isOutgoing = record.direction === 'OUTGOING';
            const isSos = record.packet.priority === 'CRITICAL_SOS';
            const isUrgent = record.packet.priority === 'URGENT';
            const isAck = record.packet.messageType === 'ACK';

            return (
              <View
                key={record.id}
                style={[
                  styles.messageCard,
                  isOutgoing ? styles.outgoingCard : styles.incomingCard,
                  isSos && styles.sosCard,
                  isUrgent && styles.urgentCard,
                ]}
              >
                {/* Meta Header */}
                <View style={styles.cardMeta}>
                  <View style={styles.nodesRouting}>
                    <Text style={styles.directionIcon}>
                      {isOutgoing ? '↗️ OUT' : '↙️ IN'}
                    </Text>
                    <Text style={styles.nodeRouteText}>
                      {record.packet.senderId}{' '}
                      <Text style={styles.arrowText}>→</Text>{' '}
                      {record.packet.destinationId}
                    </Text>
                  </View>

                  <View style={styles.rightMeta}>
                    {/* Priority Badge */}
                    {isSos && (
                      <View style={styles.sosBadge}>
                        <Text style={styles.sosBadgeText}>SOS</Text>
                      </View>
                    )}
                    {isUrgent && !isSos && (
                      <View style={styles.urgentBadge}>
                        <Text style={styles.urgentBadgeText}>URGENT</Text>
                      </View>
                    )}
                    <Text style={styles.timeText}>
                      {formatTime(record.packet.timestamp)}
                    </Text>
                  </View>
                </View>

                {/* Message Payload Content */}
                <Text
                  style={[
                    styles.payloadText,
                    isSos && styles.sosPayloadText,
                    isAck && styles.ackPayloadText,
                  ]}
                >
                  {record.packet.payload}
                </Text>

                {/* Footer Info: Status, Latency, Hops, Checksum */}
                <View style={styles.cardFooter}>
                  <View style={styles.statusRow}>
                    <Text
                      style={[
                        styles.statusBadge,
                        record.status === 'ACKNOWLEDGED' &&
                          styles.statusAcknowledged,
                        record.status === 'DELIVERED' &&
                          styles.statusDelivered,
                        record.status === 'SENDING' && styles.statusSending,
                        record.status === 'FAILED' && styles.statusFailed,
                      ]}
                    >
                      {record.status === 'ACKNOWLEDGED'
                        ? '🛡️ ACKNOWLEDGED'
                        : record.status === 'DELIVERED'
                        ? '✓ DELIVERED'
                        : record.status === 'SENDING'
                        ? '⏳ SENDING'
                        : record.status}
                    </Text>

                    {record.latencyMs !== undefined && (
                      <Text style={styles.latencyText}>
                        ⚡ {record.latencyMs}ms
                      </Text>
                    )}
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagText}>
                      Hops: {record.packet.hopCount} • TTL: {record.packet.ttl}
                    </Text>
                    <Text style={styles.checksumText}>
                      #{record.packet.checksum || 'OK'}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0F172A',
    padding: 16,
    flex: 1,
  },
  header: {
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  countBadge: {
    backgroundColor: '#334155',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  countText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  tabsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
  },
  tabActive: {
    backgroundColor: '#0284C7',
    borderColor: '#38BDF8',
  },
  tabText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94A3B8',
  },
  tabTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  messagesList: {
    maxHeight: 400,
  },
  messageCard: {
    backgroundColor: '#1E293B',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  outgoingCard: {
    borderLeftWidth: 3,
    borderLeftColor: '#38BDF8',
  },
  incomingCard: {
    borderLeftWidth: 3,
    borderLeftColor: '#10B981',
  },
  sosCard: {
    borderLeftColor: '#EF4444',
    backgroundColor: '#2D1515',
  },
  urgentCard: {
    borderLeftColor: '#F59E0B',
  },
  cardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  nodesRouting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  directionIcon: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
  },
  nodeRouteText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  arrowText: {
    color: '#38BDF8',
    fontWeight: '800',
  },
  rightMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sosBadge: {
    backgroundColor: '#DC2626',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  sosBadgeText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  urgentBadge: {
    backgroundColor: '#B45309',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  urgentBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#FEF3C7',
  },
  timeText: {
    fontSize: 10,
    color: '#64748B',
  },
  payloadText: {
    fontSize: 13,
    color: '#E2E8F0',
    lineHeight: 18,
    marginBottom: 8,
  },
  sosPayloadText: {
    color: '#FEE2E2',
    fontWeight: '600',
  },
  ackPayloadText: {
    color: '#93C5FD',
    fontFamily: 'monospace',
    fontSize: 11,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
  },
  statusDelivered: {
    color: '#34D399',
  },
  statusAcknowledged: {
    color: '#38BDF8',
  },
  statusSending: {
    color: '#FBBF24',
  },
  statusFailed: {
    color: '#F87171',
  },
  latencyText: {
    fontSize: 10,
    color: '#FCD34D',
    fontWeight: '600',
  },
  diagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  diagText: {
    fontSize: 10,
    color: '#64748B',
  },
  checksumText: {
    fontSize: 9,
    color: '#475569',
    fontFamily: 'monospace',
  },
  emptyFeed: {
    backgroundColor: '#1E293B',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  emptyFeedText: {
    fontSize: 12,
    color: '#64748B',
  },
});

