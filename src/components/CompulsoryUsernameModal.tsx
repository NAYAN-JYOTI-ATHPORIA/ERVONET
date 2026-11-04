import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';

interface CompulsoryUsernameModalProps {
  visible: boolean;
  deviceId: string;
  onSave: (username: string) => void;
}

export const CompulsoryUsernameModal: React.FC<CompulsoryUsernameModalProps> = ({
  visible,
  deviceId,
  onSave,
}) => {
  const [username, setUsername] = useState('');
  const [errorText, setErrorText] = useState('');

  const handleSave = () => {
    const clean = username.trim();
    if (!clean) {
      setErrorText('Name is compulsory. You must enter a name to use ERVONET.');
      return;
    }
    if (clean.length < 2) {
      setErrorText('Name must be at least 2 characters long.');
      return;
    }
    if (clean.length > 15) {
      setErrorText('Name must be 15 characters or less for offline BLE packets.');
      return;
    }
    setErrorText('');
    onSave(clean);
  };

  const isButtonEnabled = username.trim().length >= 2;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      statusBarTranslucent={true}
      onRequestClose={() => {
        // Compulsory: do not allow hardware back button dismissal
      }}
    >
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Tactical Monogram & Header */}
          <View style={styles.header}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>E</Text>
            </View>
            <View style={styles.brandTitleWrap}>
              <View style={styles.titleRow}>
                <Text style={styles.appTitle}>ERVONET</Text>
                <View style={styles.meshBadge}>
                  <View style={styles.meshBadgeDot} />
                  <Text style={styles.meshBadgeText}>OFFLINE MESH</Text>
                </View>
              </View>
              <Text style={styles.appSubtitle}>
                Emergency Relay Via Offline Nodes
              </Text>
            </View>
          </View>

          {/* Device Hardware Identity Card */}
          <View style={styles.deviceIdCard}>
            <Text style={styles.deviceIdLabel}>FIXED HARDWARE IDENTITY</Text>
            <Text style={styles.deviceIdValue}>{deviceId || 'ERVO-NODE'}</Text>
            <Text style={styles.deviceIdDesc}>
              This permanent ID uniquely identifies this physical phone across Bluetooth mesh relays.
            </Text>
          </View>

          {/* Mandatory Requirement Banner */}
          <View style={styles.mandatoryNotice}>
            <View style={styles.noticeHeaderRow}>
              <Text style={styles.noticeIcon}>⚠️</Text>
              <Text style={styles.noticeTitle}>NAME REGISTRATION COMPULSORY</Text>
            </View>
            <Text style={styles.noticeBody}>
              To prevent anonymous confusion during emergency response and disaster transmission, saving your callsign or name is mandatory.
            </Text>
            <Text style={styles.noticeHighlight}>
              Without saving your name, you cannot access or use this app.
            </Text>
          </View>

          {/* Name Input Section */}
          <View style={styles.inputContainer}>
            <View style={styles.inputLabelRow}>
              <Text style={styles.inputLabel}>YOUR CALLSIGN / NAME *</Text>
              <Text style={styles.charCount}>{username.trim().length}/15</Text>
            </View>

            <TextInput
              style={[
                styles.textInput,
                errorText ? styles.textInputError : null,
              ]}
              placeholder="e.g. Alice, Dr. Sam, Alex"
              placeholderTextColor="#475569"
              value={username}
              onChangeText={(txt) => {
                setUsername(txt);
                if (errorText) setErrorText('');
              }}
              maxLength={15}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />

            {errorText ? (
              <Text style={styles.errorText}>{errorText}</Text>
            ) : (
              <Text style={styles.inputHint}>
                Nearby emergency workers and offline peers will see this name.
              </Text>
            )}
          </View>

          {/* Save & Unlock App Button */}
          <TouchableOpacity
            style={[
              styles.saveBtn,
              !isButtonEnabled && styles.saveBtnDisabled,
            ]}
            onPress={handleSave}
            activeOpacity={0.8}
            disabled={!isButtonEnabled}
          >
            <Text style={styles.saveBtnText}>SAVE & ACTIVATE ERVONET</Text>
            <Text style={styles.saveBtnSub}>
              Locks in Identity & Enables Offline Bluetooth Mesh
            </Text>
          </TouchableOpacity>

          {/* Offline Security Guarantee */}
          <View style={styles.securityBox}>
            <Text style={styles.securityText}>
              🔒 100% Offline: Stored directly on this device. No cell towers, Wi-Fi, or cloud accounts needed.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    backgroundColor: '#050811',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: Platform.OS === 'android' ? 44 : 54,
    paddingBottom: 36,
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    gap: 14,
  },
  brandMark: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#0C2A44',
    borderWidth: 1.5,
    borderColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 26,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 0.5,
  },
  brandTitleWrap: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  appTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#F8FAFC',
    letterSpacing: 1.2,
  },
  meshBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0A1A2F',
    borderWidth: 1,
    borderColor: '#0284C7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 4,
  },
  meshBadgeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#38BDF8',
  },
  meshBadgeText: {
    fontSize: 8.5,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 0.6,
  },
  appSubtitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94A3B8',
    marginTop: 2,
  },
  deviceIdCard: {
    backgroundColor: '#0B132B',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1E293B',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
  },
  deviceIdLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  deviceIdValue: {
    fontSize: 18,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 1,
    marginBottom: 4,
  },
  deviceIdDesc: {
    fontSize: 11,
    color: '#94A3B8',
    lineHeight: 16,
  },
  mandatoryNotice: {
    backgroundColor: '#1E1605',
    borderRadius: 10,
    borderWidth: 1.2,
    borderColor: '#F59E0B',
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 20,
  },
  noticeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  noticeIcon: {
    fontSize: 14,
  },
  noticeTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: '#FCD34D',
    letterSpacing: 0.8,
  },
  noticeBody: {
    fontSize: 12.5,
    color: '#E2E8F0',
    lineHeight: 18,
    marginBottom: 6,
  },
  noticeHighlight: {
    fontSize: 12.5,
    fontWeight: '800',
    color: '#FBBF24',
    lineHeight: 18,
  },
  inputContainer: {
    marginBottom: 22,
  },
  inputLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '900',
    color: '#E2E8F0',
    letterSpacing: 0.6,
  },
  charCount: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
  },
  textInput: {
    backgroundColor: '#0F172A',
    borderWidth: 1.5,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 16,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  textInputError: {
    borderColor: '#EF4444',
  },
  errorText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#EF4444',
    marginTop: 6,
  },
  inputHint: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 6,
  },
  saveBtn: {
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
    marginBottom: 18,
  },
  saveBtnDisabled: {
    backgroundColor: '#1E293B',
    shadowOpacity: 0,
    elevation: 0,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.8,
  },
  saveBtnSub: {
    fontSize: 10,
    fontWeight: '600',
    color: '#BAE6FD',
    marginTop: 2,
    opacity: 0.9,
  },
  securityBox: {
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  securityText: {
    fontSize: 10.5,
    fontWeight: '600',
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 16,
  },
});

