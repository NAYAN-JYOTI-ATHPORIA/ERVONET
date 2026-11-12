/* eslint-env jest */
const { NativeModules, PermissionsAndroid } = require('react-native');

NativeModules.ResQNetBle = {
  getBluetoothStatus: jest.fn(() =>
    Promise.resolve({
      isSupported: true,
      isEnabled: true,
      hasPermissions: true,
      isAdvertising: false,
      isScanning: false,
      fixedDeviceId: 'ERVO-TEST',
    })
  ),
  getFixedDeviceId: jest.fn(() => Promise.resolve('ERVO-TEST')),
  getSavedUsername: jest.fn(() => Promise.resolve('Tester')),
  saveUsername: jest.fn(() => Promise.resolve(true)),
  requestEnableBluetooth: jest.fn(() => Promise.resolve(true)),
  openBluetoothSettings: jest.fn(() => Promise.resolve(true)),
  getDeviceLocation: jest.fn(() => Promise.resolve(null)),
  startLocationUpdates: jest.fn(() => Promise.resolve(true)),
  startAdvertising: jest.fn(() => Promise.resolve(true)),
  stopAdvertising: jest.fn(() => Promise.resolve(true)),
  startScanning: jest.fn(() => Promise.resolve(true)),
  stopScanning: jest.fn(() => Promise.resolve(true)),
  connect: jest.fn(() => Promise.resolve(true)),
  disconnect: jest.fn(() => Promise.resolve(true)),
  sendMessage: jest.fn(() => Promise.resolve(true)),
  broadcastMessage: jest.fn(() => Promise.resolve({ deliveredCount: 0, totalNodes: 0 })),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

if (PermissionsAndroid) {
  PermissionsAndroid.request = jest.fn(() => Promise.resolve('granted'));
  PermissionsAndroid.requestMultiple = jest.fn(() =>
    Promise.resolve({
      'android.permission.ACCESS_FINE_LOCATION': 'granted',
      'android.permission.ACCESS_COARSE_LOCATION': 'granted',
      'android.permission.BLUETOOTH_SCAN': 'granted',
      'android.permission.BLUETOOTH_CONNECT': 'granted',
      'android.permission.BLUETOOTH_ADVERTISE': 'granted',
    })
  );
}

