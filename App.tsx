/**
 * ERVONET — Emergency Relay Via Offline Nodes for Emergency Transmission
 * Node-to-Node Offline BLE Communication App
 */

import React, { useState, useEffect } from 'react';
import {
  StatusBar,
  StyleSheet,
  SafeAreaView,
  View,
  Platform,
  AppState,
} from 'react-native';
import { MainScreen } from './src/screens/MainScreen';
import { BluetoothRequiredModal } from './src/components/BluetoothRequiredModal';
import { bleService } from './src/services/bleService';
import { bleBridge } from './src/services/nativeBleBridge';

function App(): React.JSX.Element {
  const [isBluetoothEnabled, setIsBluetoothEnabled] = useState<boolean>(
    bleService.getStateSnapshot().radioState.isEnabled
  );

  useEffect(() => {
    // 1. Initial status query
    bleBridge.getBluetoothStatus().then((status) => {
      setIsBluetoothEnabled(status.isEnabled);
    });

    // 2. Subscribe to BLE service radioState
    const unsubscribe = bleService.subscribe((state) => {
      setIsBluetoothEnabled(state.radioState.isEnabled);
    });

    // 3. Listen to app foreground / background transitions
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        bleBridge.getBluetoothStatus().then((status) => {
          setIsBluetoothEnabled(status.isEnabled);
        });
      }
    });

    // 4. Continuous heartbeat check every 1.5 seconds as a foolproof safeguard
    const interval = setInterval(() => {
      bleBridge.getBluetoothStatus().then((status) => {
        setIsBluetoothEnabled(status.isEnabled);
      });
    }, 1500);

    return () => {
      unsubscribe();
      appStateSub.remove();
      clearInterval(interval);
    };
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safeArea}>
        <MainScreen />
      </SafeAreaView>
      <BluetoothRequiredModal visible={!isBluetoothEnabled} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#090D1A', // Seamless status bar color matching header
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 28) : 0,
  },
  safeArea: {
    flex: 1,
    backgroundColor: '#050811',
  },
});

export default App;
