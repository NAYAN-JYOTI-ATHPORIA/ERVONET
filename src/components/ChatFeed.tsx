import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { MessageRecord, DeliveryStatus } from '../types/message';
import { formatTime } from '../utils/formatters';

interface ChatFeedProps {
  messages: MessageRecord[];
  localNodeId: string;
  onClearChat?: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
}

const getStatusDisplay = (status: DeliveryStatus) => {
  switch (status) {
    case 'ACKNOWLEDGED':
      return {
        text: '✓✓ Confirmed',
        color: '#10B981', // Emerald green
        isFailed: false,
        isQueued: false,
        canRetry: false,
      };
    case 'DELIVERED':
      return {
        text: '✓✓ Delivered',
        color: '#38BDF8', // Cyan sky
        isFailed: false,
        isQueued: false,
        canRetry: false,
      };
    case 'SENT':
      return {
        text: '✓ Sent',
        color: '#BAE6FD', // Light sky blue
        isFailed: false,
        isQueued: false,
        canRetry: false,
      };
    case 'SENDING':
      return {
        text: '⏳ Sending',
        color: '#94A3B8', // Slate grey
        isFailed: false,
        isQueued: false,
        canRetry: false,
      };
    case 'QUEUED':
      return {
        text: '⏳ Outbox',
        color: '#F59E0B', // Amber warning
        isFailed: false,
        isQueued: true,
        canRetry: true,
      };
    case 'FAILED':
      return {
        text: '✕ Failed',
        color: '#EF4444', // Red
        isFailed: true,
        isQueued: false,
        canRetry: true,
      };
    default:
      return {
        text: '✓ Sent',
        color: '#BAE6FD',
        isFailed: false,
        isQueued: false,
        canRetry: false,
      };
  }
};

export const ChatFeed: React.FC<ChatFeedProps> = ({
  messages,
  localNodeId,
  onClearChat,
  onDeleteMessage,
  onRetryMessage,
}) => {
  const scrollViewRef = useRef<any>(null);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  const handleMessageLongPress = (record: MessageRecord) => {
    const isOutgoing = record.direction === 'OUTGOING';
    const sender = isOutgoing
      ? 'You'
      : record.packet.senderName || record.packet.senderId;

    const canRetry =
      isOutgoing &&
      (record.status === 'QUEUED' || record.status === 'FAILED') &&
      !!onRetryMessage;

    Alert.alert(
      'Message Options',
      `"${record.packet.payload.slice(0, 60)}${
        record.packet.payload.length > 60 ? '...' : ''
      }"\nFrom: ${sender} • Status: ${record.status}`,
      [
        { text: 'Cancel', style: 'cancel' },
        ...(canRetry
          ? [
              {
                text: '🔄 Retry Transmission',
                onPress: () => onRetryMessage!(record.id),
              },
            ]
          : []),
        ...(onDeleteMessage
          ? [
              {
                text: 'Delete Message',
                style: 'destructive' as const,
                onPress: () => onDeleteMessage(record.id),
              },
            ]
          : []),
        ...(onClearChat
          ? [
              {
                text: 'Clear Entire Chat',
                style: 'destructive' as const,
                onPress: confirmClearAll,
              },
            ]
          : []),
      ]
    );
  };

  const confirmClearAll = () => {
    if (!onClearChat) return;
    Alert.alert(
      'Clear Conversation?',
      'Are you sure you want to remove all messages in this view?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Messages',
          style: 'destructive',
          onPress: onClearChat,
        },
      ]
    );
  };

  const nonAckMessages = messages.filter(
    (m) => m.packet.messageType !== 'ACK'
  );

  return (
    <View style={styles.container}>
      {/* Sleek Top Feed Bar: Message Count & Clear Action */}
      {nonAckMessages.length > 0 && onClearChat && (
        <View style={styles.topToolbar}>
          <Text style={styles.toolbarInfo}>
            {nonAckMessages.length} {nonAckMessages.length === 1 ? 'MESSAGE' : 'MESSAGES'}
          </Text>
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={confirmClearAll}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.7}
          >
            <Text style={styles.clearBtnText}>🗑️ Clear Chat</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollArea}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {nonAckMessages.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>Offline Mesh Listening</Text>
            <Text style={styles.emptySubtitle}>
              Nearby phones running ERVONET communicate directly over Bluetooth without cellular network or Wi-Fi.
            </Text>
            <View style={styles.emptyHintBox}>
              <Text style={styles.emptyHintText}>
                Tap "Everyone" to broadcast, or select a person in Nearby Devices to chat directly.
              </Text>
            </View>
          </View>
        ) : (
          nonAckMessages.map((record) => {
            const isOutgoing = record.direction === 'OUTGOING';
            const isSos = record.packet.priority === 'CRITICAL_SOS';
            const isUrgent = record.packet.priority === 'URGENT';
            const statusInfo = getStatusDisplay(record.status);

            const isBroadcastMsg =
              record.packet.destinationId === 'BROADCAST' ||
              record.packet.destinationId === '#all';
            const isChannelMsg =
              record.packet.destinationId.startsWith('#') &&
              record.packet.destinationId !== '#all';

            // Clean header formatting:
            // 1-on-1 personal outgoing: no header needed (clean modern chat)
            // Broadcast outgoing: 'To: Everyone (Broadcast)'
            // Channel outgoing: 'To: #channel'
            // Broadcast incoming: 'From: Sender • Everyone'
            // Channel incoming: 'From: Sender • #channel'
            // 1-on-1 incoming: 'Sender' (no redundant '(Personal)')
            let senderLabel: string | null = null;
            if (isOutgoing) {
              if (isBroadcastMsg) {
                senderLabel = 'To: Everyone (Broadcast)';
              } else if (isChannelMsg) {
                senderLabel = `To: ${record.packet.destinationId}`;
              }
            } else {
              const sender = record.packet.senderName || record.packet.senderId;
              if (isBroadcastMsg) {
                senderLabel = `From: ${sender} • Everyone`;
              } else if (isChannelMsg) {
                senderLabel = `From: ${sender} • ${record.packet.destinationId}`;
              } else {
                senderLabel = sender;
              }
            }

            return (
              <View
                key={record.id}
                style={[
                  styles.bubbleWrapper,
                  isOutgoing ? styles.outgoingWrapper : styles.incomingWrapper,
                ]}
              >
                <TouchableOpacity
                  activeOpacity={0.88}
                  onLongPress={() => handleMessageLongPress(record)}
                  delayLongPress={350}
                  style={[
                    styles.bubble,
                    isOutgoing ? styles.outgoingBubble : styles.incomingBubble,
                    isSos && styles.sosBubble,
                    isUrgent && styles.urgentBubble,
                    statusInfo.isFailed && styles.failedBubble,
                  ]}
                >
                  {/* Sender Name / Target Header (Only when meaningful or SOS) */}
                  {(senderLabel || isSos) && (
                    <View style={styles.bubbleHeader}>
                      {senderLabel && (
                        <Text
                          style={[
                            styles.senderName,
                            isOutgoing && styles.senderNameOutgoing,
                            isSos && styles.senderNameSos,
                          ]}
                          numberOfLines={1}
                        >
                          {senderLabel}
                        </Text>
                      )}
                      {isSos && (
                        <View style={styles.sosPill}>
                          <Text style={styles.sosPillText}>CRITICAL SOS</Text>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Message Content */}
                  <Text
                    style={[
                      styles.messageText,
                      isOutgoing && styles.messageTextOutgoing,
                      isSos && styles.messageTextSos,
                    ]}
                    selectable
                  >
                    {record.packet.payload}
                  </Text>

                  {/* Footer with Timestamp, Mesh Hop Badge, and Delivery Receipts */}
                  <View style={styles.bubbleFooter}>
                    {!isOutgoing && (
                      <View style={styles.hopBadge}>
                        <Text style={styles.hopBadgeText}>
                          {record.packet.hopCount === 0 || !record.packet.hopCount
                            ? 'Direct'
                            : record.packet.hopCount === 1
                            ? '1 Hop'
                            : `${record.packet.hopCount} Hops`}
                        </Text>
                      </View>
                    )}

                    <Text
                      style={[
                        styles.timestampText,
                        isOutgoing && styles.timestampTextOutgoing,
                      ]}
                    >
                      {formatTime(record.packet.timestamp)}
                    </Text>

                    {isOutgoing && (
                      <View style={styles.statusWrap}>
                        <Text
                          style={[
                            styles.statusCheckmarks,
                            { color: statusInfo.color },
                          ]}
                        >
                          {statusInfo.text}
                        </Text>
                        {statusInfo.canRetry && onRetryMessage && (
                          <TouchableOpacity
                            style={styles.retryBubbleBtn}
                            onPress={() => onRetryMessage(record.id)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.retryBubbleText}>Retry</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050811', // Deep OLED pure dark background for extreme power saving
  },
  topToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 3.5,
    backgroundColor: '#090D1A',
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  toolbarInfo: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.6,
  },
  clearBtn: {
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 5,
    backgroundColor: '#1E293B',
  },
  clearBtnText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#94A3B8',
  },
  scrollArea: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bubbleWrapper: {
    flexDirection: 'row',
    marginBottom: 5,
  },
  outgoingWrapper: {
    justifyContent: 'flex-end',
  },
  incomingWrapper: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 6.5,
  },
  outgoingBubble: {
    backgroundColor: '#0369A1', // Clean accessible crisis teal/cyan
    borderBottomRightRadius: 3,
  },
  incomingBubble: {
    backgroundColor: '#141D2D', // Deep charcoal with crisp contrast
    borderBottomLeftRadius: 3,
    borderWidth: 1,
    borderColor: '#243247',
  },
  sosBubble: {
    backgroundColor: '#380B0F',
    borderColor: '#EF4444',
    borderWidth: 1.5,
  },
  urgentBubble: {
    borderColor: '#F59E0B',
    borderWidth: 1.2,
  },
  bubbleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  senderName: {
    fontSize: 11,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.2,
  },
  senderNameOutgoing: {
    color: '#BAE6FD',
  },
  senderNameSos: {
    color: '#FCA5A5',
  },
  sosPill: {
    backgroundColor: '#DC2626',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 6,
  },
  sosPillText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  messageText: {
    fontSize: 14.5,
    color: '#F8FAFC',
    lineHeight: 21,
  },
  messageTextOutgoing: {
    color: '#FFFFFF',
  },
  messageTextSos: {
    color: '#FEF2F2',
    fontWeight: '700',
  },
  bubbleFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 5,
    gap: 6,
  },
  hopBadge: {
    backgroundColor: '#0A1220',
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
    borderWidth: 0.5,
    borderColor: '#1E293B',
    marginRight: 2,
  },
  hopBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#38BDF8',
    letterSpacing: 0.3,
  },
  timestampText: {
    fontSize: 10,
    color: '#64748B',
  },
  timestampTextOutgoing: {
    color: '#BAE6FD',
    opacity: 0.85,
  },
  statusWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusCheckmarks: {
    fontSize: 10,
    fontWeight: '700',
  },
  retryBubbleBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
    marginLeft: 6,
    borderWidth: 0.8,
    borderColor: '#F59E0B',
  },
  retryBubbleText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#FCD34D',
  },
  failedBubble: {
    borderColor: '#EF4444',
    borderWidth: 1.2,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 50,
    paddingHorizontal: 24,
  },
  emptyIconCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyIcon: {
    fontSize: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#F8FAFC',
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  emptyHintBox: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  emptyHintText: {
    fontSize: 12,
    color: '#38BDF8',
    textAlign: 'center',
    lineHeight: 17,
  },
});
