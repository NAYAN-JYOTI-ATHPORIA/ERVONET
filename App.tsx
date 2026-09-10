/**
 * ERVONET — Emergency Relay Via Offline Nodes for Emergency Transmission
 * Node-to-Node Offline BLE Communication App
 */

import React from 'react';
import {
  StatusBar,
  StyleSheet,
  SafeAreaView,
  View,
  Platform,
} from 'react-native';
import { MainScreen } from './src/screens/MainScreen';

function App(): React.JSX.Element {
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safeArea}>
        <MainScreen />
      </SafeAreaView>
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
