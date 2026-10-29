import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

interface ChatInputBarProps {
  selectedTargetId: string;
  selectedTargetName?: string;
  onResetTargetToBroadcast: () => void;
  onSendMessage: (text: string) => Promise<boolean>;
}

export const ChatInputBar: React.FC<ChatInputBarProps> = ({
  selectedTargetId,
  selectedTargetName,
  onResetTargetToBroadcast,
  onSendMessage,
}) => {
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);

  const isBroadcast = selectedTargetId === 'BROADCAST' || selectedTargetId === '#all';
  const targetLabel = isBroadcast
    ? 'Everyone (Broadcast)'
    : selectedTargetId.startsWith('#')
    ? `Channel ${selectedTargetId}`
    : selectedTargetName || selectedTargetId;

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    try {
      const ok = await onSendMessage(trimmed);
      if (ok) {
        setText('');
      }
    } finally {
      setIsSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 0}
      style={styles.keyboardContainer}
    >
      <View style={styles.container}>
        {/* Recipient Indicator (shown when specific target/channel selected) */}
        {!isBroadcast && (
          <View style={styles.recipientBar}>
            <Text style={styles.recipientLabel}>To:</Text>
            <View style={styles.recipientPill}>
              <Text style={styles.recipientText} numberOfLines={1}>
                {targetLabel}
              </Text>
              <TouchableOpacity
                onPress={onResetTargetToBroadcast}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.clearTargetBtn}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Input & Send Button Row */}
        <View style={styles.inputRow}>
          <View style={styles.inputFieldContainer}>
            <TextInput
              style={styles.textInput}
              value={text}
              onChangeText={setText}
              placeholder={isBroadcast ? "Broadcast message to all nearby..." : `Message ${targetLabel}...`}
              placeholderTextColor="#64748B"
              multiline
              maxLength={250}
            />
          </View>

          <TouchableOpacity
            style={[
              styles.sendButton,
              (!text.trim() || isSending) && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!text.trim() || isSending}
            activeOpacity={0.7}
          >
            <Text style={styles.sendIcon}>{isSending ? '...' : '➔'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  keyboardContainer: {
    backgroundColor: '#090D1A',
  },
  container: {
    backgroundColor: '#090D1A',
    paddingHorizontal: 10,
    paddingTop: 5,
    paddingBottom: 6,
    borderTopWidth: 1,
    borderTopColor: '#162032',
  },
  recipientBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 4,
  },
  recipientLabel: {
    fontSize: 10,
    color: '#64748B',
    fontWeight: '700',
  },
  recipientPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderRadius: 10,
    gap: 5,
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  recipientText: {
    fontSize: 10.5,
    color: '#38BDF8',
    fontWeight: '700',
  },
  clearTargetBtn: {
    fontSize: 10,
    color: '#94A3B8',
    fontWeight: '800',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  inputFieldContainer: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#1F2937',
    maxHeight: 90,
  },
  textInput: {
    fontSize: 13.5,
    color: '#F8FAFC',
    padding: 0,
    minHeight: 22,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#334155',
    shadowOpacity: 0,
    elevation: 0,
  },
  sendIcon: {
    fontSize: 18,
    color: '#FFFFFF',
    fontWeight: '900',
  },
});

