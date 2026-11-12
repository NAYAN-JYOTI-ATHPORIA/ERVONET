#ifndef ERVONET_COMM_ESPNOW_H
#define ERVONET_COMM_ESPNOW_H

#include "config.h"
#include "protocol.h"
#include "routing_table.h"
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

void handleCompletePacket(const String& rawJson, bool fromBle);

// ============================================================================
// STRUCTURED ESP-NOW FRAMES (<= 250 bytes per ESP-NOW v1.0 specification)
// ============================================================================
enum EspNowFrameType : uint8_t {
  FRAME_BEACON = 1,
  FRAME_PACKET_PART = 2
};

#pragma pack(push, 1)
struct EspNowBeaconFrame {
  uint8_t type;              // FRAME_BEACON
  char nodeId[16];           // e.g. "ERVO-ES9A"
  char nodeName[24];         // e.g. "ESP32-Relay-9A"
  uint32_t uptimeSec;
};

struct EspNowPartFrame {
  uint8_t type;              // FRAME_PACKET_PART
  uint32_t msgHash;          // FNV-1a hash of messageId + length
  char relayNodeId[16];      // Immediate sender ESP32 nodeId
  uint8_t partIndex;         // 0..totalParts-1
  uint8_t totalParts;        // >= 1
  uint8_t dataLen;           // <= ESPNOW_CHUNK_BYTES
  char data[ESPNOW_CHUNK_BYTES];
};
#pragma pack(pop)

struct QueuedEspNowRx {
  uint8_t srcMac[6];
  int8_t rssi;
  int len;
  uint8_t raw[250];
};

static uint8_t espNowBroadcastMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static QueueHandle_t espNowRxQueue = nullptr;

// ============================================================================
// ISR / WIFI TASK RECEIVE CALLBACK (Arduino-ESP32 Core 2.x & 3.x compatible)
// ============================================================================
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
void onEspNowDataRecv(const esp_now_recv_info_t* recvInfo, const uint8_t* data, int len) {
  if (!recvInfo || !data || len <= 0 || len > 250 || espNowRxQueue == nullptr) return;
  QueuedEspNowRx item;
  memcpy(item.srcMac, recvInfo->src_addr, 6);
  item.rssi = (recvInfo->rx_ctrl != nullptr) ? (int8_t)recvInfo->rx_ctrl->rssi : -62;
  item.len = len;
  memcpy(item.raw, data, len);
  xQueueSendFromISR(espNowRxQueue, &item, nullptr);
}
#else
void onEspNowDataRecv(const uint8_t* mac, const uint8_t* data, int len) {
  if (!mac || !data || len <= 0 || len > 250 || espNowRxQueue == nullptr) return;
  QueuedEspNowRx item;
  memcpy(item.srcMac, mac, 6);
  item.rssi = -62;
  item.len = len;
  memcpy(item.raw, data, len);
  xQueueSendFromISR(espNowRxQueue, &item, nullptr);
}
#endif

static void initEspNow() {
  espNowRxQueue = xQueueCreate(24, sizeof(QueuedEspNowRx));

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true);
  esp_wifi_set_ps(WIFI_PS_NONE); // Mandatory for responsive BLE + Wi-Fi 2.4 GHz coexistence
  esp_wifi_set_channel(WIFI_MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] Init failed! Restarting in 3s...");
    delay(3000);
    ESP.restart();
  }

  esp_now_register_recv_cb(onEspNowDataRecv);

  esp_now_peer_info_t bcastPeer = {};
  memcpy(bcastPeer.peer_addr, espNowBroadcastMac, 6);
  bcastPeer.channel = WIFI_MESH_CHANNEL;
  bcastPeer.encrypt = false;
  esp_now_add_peer(&bcastPeer);

  Serial.printf("[ESP-NOW] Active on Wi-Fi Ch %d | STA MAC: %s\n",
                WIFI_MESH_CHANNEL, WiFi.macAddress().c_str());
}

static bool sendJsonOverEspNow(const String& packetJson, const String& msgId) {
  uint32_t msgHash = fnv1aHash(msgId + "|" + String(packetJson.length()));
  size_t totalLen = packetJson.length();
  uint8_t totalParts = (uint8_t)((totalLen + ESPNOW_CHUNK_BYTES - 1) / ESPNOW_CHUNK_BYTES);
  if (totalParts == 0) totalParts = 1;
  if (totalParts > 15) {
    Serial.printf("[ESP-NOW] Packet too large (%u bytes), dropping\n", (unsigned int)totalLen);
    return false;
  }

  if (espTxMutex != nullptr) xSemaphoreTake(espTxMutex, portMAX_DELAY);
  bool allOk = true;
  for (uint8_t partIdx = 0; partIdx < totalParts; partIdx++) {
    EspNowPartFrame frame;
    memset(&frame, 0, sizeof(frame));
    frame.type = FRAME_PACKET_PART;
    frame.msgHash = msgHash;
    strncpy(frame.relayNodeId, myNodeId.c_str(), sizeof(frame.relayNodeId) - 1);
    frame.partIndex = partIdx;
    frame.totalParts = totalParts;

    size_t start = (size_t)partIdx * ESPNOW_CHUNK_BYTES;
    size_t remaining = totalLen - start;
    uint8_t chunkLen = (uint8_t)(remaining > ESPNOW_CHUNK_BYTES ? ESPNOW_CHUNK_BYTES : remaining);
    frame.dataLen = chunkLen;
    memcpy(frame.data, packetJson.c_str() + start, chunkLen);

    esp_err_t err = esp_now_send(espNowBroadcastMac, (uint8_t*)&frame, sizeof(frame));
    if (err != ESP_OK) {
      allOk = false;
      Serial.printf("[ESP-NOW] Send error on part %u/%u: %d\n", partIdx + 1, totalParts, (int)err);
    }
    if (totalParts > 1) delay(10);
  }
  if (espTxMutex != nullptr) xSemaphoreGive(espTxMutex);
  return allOk;
}

static void sendEspNowBeacon() {
  if (espTxMutex != nullptr) xSemaphoreTake(espTxMutex, portMAX_DELAY);
  EspNowBeaconFrame beacon;
  memset(&beacon, 0, sizeof(beacon));
  beacon.type = FRAME_BEACON;
  strncpy(beacon.nodeId, myNodeId.c_str(), sizeof(beacon.nodeId) - 1);
  strncpy(beacon.nodeName, myNodeName.c_str(), sizeof(beacon.nodeName) - 1);
  beacon.uptimeSec = (uint32_t)(millis() / 1000);
  esp_now_send(espNowBroadcastMac, (uint8_t*)&beacon, sizeof(beacon));
  if (espTxMutex != nullptr) xSemaphoreGive(espTxMutex);
}

static void drainEspNowQueue() {
  if (espNowRxQueue == nullptr) return;
  QueuedEspNowRx item;
  while (xQueueReceive(espNowRxQueue, &item, 0) == pdTRUE) {
    uint8_t frameType = item.raw[0];
    if (frameType == FRAME_BEACON && item.len >= (int)sizeof(EspNowBeaconFrame)) {
      EspNowBeaconFrame beacon;
      memcpy(&beacon, item.raw, sizeof(beacon));
      beacon.nodeId[sizeof(beacon.nodeId) - 1] = '\0';
      beacon.nodeName[sizeof(beacon.nodeName) - 1] = '\0';
      if (takeStateLock()) {
        upsertEspNeighbor(item.srcMac, String(beacon.nodeId), String(beacon.nodeName), item.rssi);
        giveStateLock();
      }
    } else if (frameType == FRAME_PACKET_PART && item.len >= 24) {
      EspNowPartFrame part;
      memcpy(&part, item.raw, sizeof(part));
      part.relayNodeId[sizeof(part.relayNodeId) - 1] = '\0';
      if (part.dataLen > ESPNOW_CHUNK_BYTES) continue;

      String chunkStr = "";
      chunkStr.reserve(part.dataLen);
      for (uint8_t i = 0; i < part.dataLen; i++) chunkStr += part.data[i];

      String key = String(part.relayNodeId) + "-" + String((unsigned long)part.msgHash);
      String completeJson = ingestPart(espReassembly, key, part.partIndex, part.totalParts, chunkStr);
      if (completeJson.length() > 0) {
        relayStats.rxEspNowPackets++;
        handleCompletePacket(completeJson, false);
      }
    }
  }
}

#endif

