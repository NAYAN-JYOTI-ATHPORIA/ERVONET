/**
 * ERVONET Optional Expo Dev Client BLE Adapter (Reference Module)
 * --------------------------------------------------------------------------
 * NOTE ABOUT CURRENT REPOSITORY:
 *   This repository (`resqnet-offline-communication`) runs bare React Native 0.87.1
 *   with a zero-dependency native Android Kotlin BLE stack:
 *     - android/app/src/main/java/com/resqnet/ble/ResQNetConstants.kt
 *     - android/app/src/main/java/com/resqnet/ble/BleScanner.kt
 *     - android/app/src/main/java/com/resqnet/ble/ResQNetBleModule.kt
 *
 * IF YOU LATER PORT TO EXPO CUSTOM DEV CLIENT (`expo-dev-client`):
 *   Expo Go does NOT expose raw BLE GATT hardware APIs. You must create a Custom
 *   Dev Client with `react-native-ble-plx` + `expo-location` (`npx expo prebuild`).
 *   This standalone file preserves the exact same GATT UUIDs and RESQ_CHUNK framing
 *   so an Expo build talks seamlessly to `ervonet_esp32_relay.ino`.
 */

/*
// Installation steps for a standalone Expo project ONLY (do NOT run inside bare RN app):
// npx expo install react-native-ble-plx expo-location expo-dev-client
// Add plugin config in app.json:
// "plugins": [["react-native-ble-plx", { "isBackgroundEnabled": true }]]
*/

export const ERVONET_GATT = {
  SERVICE_UUID: '0000FE20-0000-1000-8000-00805F9B34FB',
  CHAR_RX_UUID: '0000FE21-0000-1000-8000-00805F9B34FB', // Mobile -> ESP32 Write
  CHAR_TX_UUID: '0000FE22-0000-1000-8000-00805F9B34FB', // ESP32 -> Mobile Notify
  CHAR_INFO_UUID: '0000FE23-0000-1000-8000-00805F9B34FB',
  MANUFACTURER_ID: 0x05f9,
} as const;

export interface ExpoBleRelayDevice {
  id: string;
  name: string;
  rssi: number;
}

/**
 * Minimal copy-ready wrapper shape for `react-native-ble-plx` (`BleManager`) in Expo Dev Client.
 * Uses base64 encoding compatible with react-native-ble-plx characteristics.
 */
export function buildChunkedFrames(rawJson: string, messageId: string, sliceSize = 180): string[] {
  if (rawJson.length <= sliceSize) {
    return [`RESQ_CHUNK:${messageId}:0:1:${rawJson}`];
  }
  const total = Math.ceil(rawJson.length / sliceSize);
  const frames: string[] = [];
  for (let i = 0; i < total; i++) {
    frames.push(`RESQ_CHUNK:${messageId}:${i}:${total}:${rawJson.slice(i * sliceSize, (i + 1) * sliceSize)}`);
  }
  return frames;
}

/**
 * ASCII/UTF-8 Base64 helpers without Node `Buffer` dependency.
 */
export function encodeUtf8Base64(text: string): string {
  const bytes = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
  // @ts-ignore global btoa exists in Hermes / RN 0.74+
  return globalThis.btoa(bytes);
}

export function decodeUtf8Base64(b64: string): string {
  // @ts-ignore global atob exists in Hermes / RN 0.74+
  const bin = globalThis.atob(b64);
  const pct = Array.from(bin, (ch: string) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return decodeURIComponent(pct);
}

