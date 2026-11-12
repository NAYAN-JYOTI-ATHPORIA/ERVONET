#ifndef ERVONET_COMM_BLE_H
#define ERVONET_COMM_BLE_H

#include "config.h"
#include "protocol.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

void handleCompletePacket(const String& rawJson, bool fromBle);

struct QueuedBleRx {
  char payload[520];
};

static BLEServer* pBleServer = nullptr;
static BLECharacteristic* pRxChar = nullptr;
static BLECharacteristic* pTxChar = nullptr;
static BLECharacteristic* pInfoChar = nullptr;
static volatile uint16_t bleClientCount = 0;
static QueueHandle_t bleRxQueue = nullptr;

// ============================================================================
// BLE GATT SERVER CALLBACKS (Coexistence-tuned + queue handoff to loop())
// ============================================================================
class RelayServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    bleClientCount++;
    Serial.printf("[BLE] Mobile client connected (active=%u)\n", (unsigned int)bleClientCount);
    // Restart advertising immediately so another phone or reconnect scan still discovers this relay
    BLEDevice::startAdvertising();
  }

  void onDisconnect(BLEServer* server) override {
    if (bleClientCount > 0) bleClientCount--;
    Serial.printf("[BLE] Mobile client disconnected (active=%u)\n", (unsigned int)bleClientCount);
    BLEDevice::startAdvertising();
  }
};

class RelayRxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    String val = pCharacteristic->getValue();
#else
    std::string stdVal = pCharacteristic->getValue();
    String val = String(stdVal.c_str());
#endif
    if (val.length() == 0 || val.length() >= sizeof(QueuedBleRx::payload) || bleRxQueue == nullptr) return;

    QueuedBleRx item;
    memset(&item, 0, sizeof(item));
    strncpy(item.payload, val.c_str(), sizeof(item.payload) - 1);
    xQueueSend(bleRxQueue, &item, 0);
  }
};

static void initBleServer() {
  bleRxQueue = xQueueCreate(24, sizeof(QueuedBleRx));

  BLEDevice::init(myNodeName.c_str());
  BLEDevice::setMTU(512);

  pBleServer = BLEDevice::createServer();
  pBleServer->setCallbacks(new RelayServerCallbacks());

  BLEService* pService = pBleServer->createService(SERVICE_UUID);

  pRxChar = pService->createCharacteristic(
      CHAR_RX_MESSAGE_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pRxChar->setCallbacks(new RelayRxCallbacks());

  pTxChar = pService->createCharacteristic(
      CHAR_TX_MESSAGE_UUID,
      BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_INDICATE);
  pTxChar->addDescriptor(new BLE2902());

  pInfoChar = pService->createCharacteristic(
      CHAR_NODE_INFO_UUID,
      BLECharacteristic::PROPERTY_READ);
  String infoJson = "{\"nodeId\":\"" + myNodeId + "\",\"role\":\"Relay Node\",\"version\":\"2.0\"}";
  pInfoChar->setValue(infoJson.c_str());

  pService->start();

  // ERVONET-compliant Advertisement + Scan Response (matches BleAdvertiser.kt / ResQNetConstants.kt)
  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinInterval(0xA0); // 100ms — shares 2.4 GHz radio cleanly with ESP-NOW
  pAdvertising->setMaxInterval(0x100); // 160ms

  String shortSuffix = myNodeId;
  shortSuffix.replace("ERVO-", "");
  String advSig = "E:" + shortSuffix.substring(0, 4) + ":" + myNodeName.substring(0, 14);

  BLEAdvertisementData scanRespData;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  String mfgBytes = "";
  mfgBytes += (char)MANUFACTURER_ID_LO;
  mfgBytes += (char)MANUFACTURER_ID_HI;
  mfgBytes += advSig;
  scanRespData.setManufacturerData(mfgBytes);
#else
  std::string mfgBytes;
  mfgBytes += (char)MANUFACTURER_ID_LO;
  mfgBytes += (char)MANUFACTURER_ID_HI;
  mfgBytes += std::string(advSig.c_str());
  scanRespData.setManufacturerData(mfgBytes);
#endif
  pAdvertising->setScanResponseData(scanRespData);

  BLEDevice::startAdvertising();
  Serial.printf("[BLE] Advertising as %s | Signature: %s\n", myNodeName.c_str(), advSig.c_str());
}

// ============================================================================
// BLE CHUNKED NOTIFICATION TX (Exact match with src/protocol/chunker.ts)
// ============================================================================
static bool sendJsonOverBle(const String& packetJson, const String& msgId) {
  if (bleClientCount == 0 || pTxChar == nullptr) return false;
  if (bleTxMutex != nullptr) xSemaphoreTake(bleTxMutex, portMAX_DELAY);

  const size_t SLICE_LEN = 180;
  size_t totalLen = packetJson.length();
  String safeMsgId = msgId.length() > 0 ? msgId : (myNodeId + "-" + String(millis()));

  if (totalLen <= SLICE_LEN) {
    String frame = "RESQ_CHUNK:" + safeMsgId + ":0:1:" + packetJson;
    pTxChar->setValue((uint8_t*)frame.c_str(), frame.length());
    pTxChar->notify();
    delay(15);
    if (bleTxMutex != nullptr) xSemaphoreGive(bleTxMutex);
    return true;
  }

  size_t totalChunks = (totalLen + SLICE_LEN - 1) / SLICE_LEN;
  for (size_t i = 0; i < totalChunks; i++) {
    size_t start = i * SLICE_LEN;
    size_t end = start + SLICE_LEN;
    if (end > totalLen) end = totalLen;
    String frame = "RESQ_CHUNK:" + safeMsgId + ":" + String(i) + ":" + String(totalChunks) + ":" +
                   packetJson.substring(start, end);
    pTxChar->setValue((uint8_t*)frame.c_str(), frame.length());
    pTxChar->notify();
    delay(18);
  }
  if (bleTxMutex != nullptr) xSemaphoreGive(bleTxMutex);
  return true;
}

static void processIncomingBleChunk(const String& raw) {
  if (!raw.startsWith("RESQ_CHUNK:")) {
    relayStats.rxBlePackets++;
    handleCompletePacket(raw, true);
    return;
  }

  // Format: RESQ_CHUNK:<messageId>:<chunkIndex>:<totalChunks>:<payload>
  String rem = raw.substring(11);
  int c1 = rem.indexOf(':');
  int c2 = (c1 != -1) ? rem.indexOf(':', c1 + 1) : -1;
  int c3 = (c2 != -1) ? rem.indexOf(':', c2 + 1) : -1;
  if (c1 == -1 || c2 == -1 || c3 == -1) return;

  String msgId = rem.substring(0, c1);
  uint8_t idx = (uint8_t)rem.substring(c1 + 1, c2).toInt();
  uint8_t tot = (uint8_t)rem.substring(c2 + 1, c3).toInt();
  String slice = rem.substring(c3 + 1);

  String complete = ingestPart(bleReassembly, msgId, idx, tot, slice);
  if (complete.length() > 0) {
    relayStats.rxBlePackets++;
    handleCompletePacket(complete, true);
  }
}

static void drainBleQueue() {
  if (bleRxQueue == nullptr) return;
  QueuedBleRx item;
  while (xQueueReceive(bleRxQueue, &item, 0) == pdTRUE) {
    processIncomingBleChunk(String(item.payload));
  }
}

#endif

