#ifndef ERVONET_ROUTING_TABLE_H
#define ERVONET_ROUTING_TABLE_H

#include "config.h"
#include "protocol.h"
#include <esp_now.h>

// ============================================================================
// NEIGHBOR, BLE CLIENT & DUPLICATE CACHE TABLES
// ============================================================================
struct ConnectedPhone {
  bool active;
  String nodeId;
  String name;
  uint32_t lastSeenMs;
};

struct EspNowNeighbor {
  bool active;
  uint8_t mac[6];
  String nodeId;
  String name;
  int8_t rssi;
  uint32_t lastSeenMs;
};

static String seenMessageIds[SEEN_MSG_CACHE_SIZE];
static int seenCacheHead = 0;

static ConnectedPhone blePhones[MAX_BLE_PHONES];
static EspNowNeighbor espNeighbors[MAX_ESPNOW_NEIGHBORS];
static uint32_t lsaSequence = 0;
static uint32_t statusSequence = 0;
static bool topologyDirty = false;

static inline bool isMessageSeen(const String& msgId) {
  if (msgId.length() == 0) return false;
  for (int i = 0; i < SEEN_MSG_CACHE_SIZE; i++) {
    if (seenMessageIds[i] == msgId) return true;
  }
  return false;
}

static inline void markMessageSeen(const String& msgId) {
  if (msgId.length() == 0) return;
  seenMessageIds[seenCacheHead] = msgId;
  seenCacheHead = (seenCacheHead + 1) % SEEN_MSG_CACHE_SIZE;
}

static void upsertBlePhone(const String& nodeId, const String& name) {
  if (nodeId.length() == 0 || nodeId == myNodeId) return;
  if (nodeId.startsWith("ERVO-ES") || nodeId.startsWith("RESQ-ES")) return;

  int freeIdx = -1;
  for (int i = 0; i < MAX_BLE_PHONES; i++) {
    if (blePhones[i].active && blePhones[i].nodeId == nodeId) {
      blePhones[i].lastSeenMs = millis();
      if (name.length() > 0 && blePhones[i].name != name) {
        blePhones[i].name = name;
        topologyDirty = true;
      }
      return;
    }
    if (!blePhones[i].active && freeIdx == -1) freeIdx = i;
  }

  if (freeIdx != -1) {
    blePhones[freeIdx].active = true;
    blePhones[freeIdx].nodeId = nodeId;
    blePhones[freeIdx].name = name.length() > 0 ? name : nodeId;
    blePhones[freeIdx].lastSeenMs = millis();
    topologyDirty = true;
    Serial.printf("[BLE] Registered phone: %s (%s)\n",
                  blePhones[freeIdx].name.c_str(), blePhones[freeIdx].nodeId.c_str());
  }
}

static inline bool hasBlePhone(const String& destId) {
  if (destId.length() == 0) return false;
  for (int i = 0; i < MAX_BLE_PHONES; i++) {
    if (blePhones[i].active && blePhones[i].nodeId.equalsIgnoreCase(destId)) {
      return true;
    }
  }
  return false;
}

static void upsertEspNeighbor(const uint8_t* mac, const String& nodeId, const String& name, int8_t rssi) {
  if (nodeId.length() == 0 || nodeId == myNodeId) return;

  if (!esp_now_is_peer_exist(mac)) {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, mac, 6);
    peerInfo.channel = WIFI_MESH_CHANNEL;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  int freeIdx = -1;
  for (int i = 0; i < MAX_ESPNOW_NEIGHBORS; i++) {
    if (espNeighbors[i].active && espNeighbors[i].nodeId == nodeId) {
      espNeighbors[i].lastSeenMs = millis();
      memcpy(espNeighbors[i].mac, mac, 6);
      espNeighbors[i].rssi = rssi;
      if (name.length() > 0) espNeighbors[i].name = name;
      return;
    }
    if (!espNeighbors[i].active && freeIdx == -1) freeIdx = i;
  }

  if (freeIdx != -1) {
    espNeighbors[freeIdx].active = true;
    memcpy(espNeighbors[freeIdx].mac, mac, 6);
    espNeighbors[freeIdx].nodeId = nodeId;
    espNeighbors[freeIdx].name = name.length() > 0 ? name : nodeId;
    espNeighbors[freeIdx].rssi = rssi;
    espNeighbors[freeIdx].lastSeenMs = millis();
    topologyDirty = true;
    Serial.printf("[ESP-NOW] Discovered relay peer: %s (%s, %d dBm)\n",
                  espNeighbors[freeIdx].name.c_str(), espNeighbors[freeIdx].nodeId.c_str(), rssi);
  }
}

static inline int countActiveEspNeighbors() {
  int cnt = 0;
  for (int i = 0; i < MAX_ESPNOW_NEIGHBORS; i++) {
    if (espNeighbors[i].active) cnt++;
  }
  return cnt;
}

static inline int countRegisteredBlePhones() {
  int cnt = 0;
  for (int i = 0; i < MAX_BLE_PHONES; i++) {
    if (blePhones[i].active) cnt++;
  }
  return cnt;
}

static void pruneStaleEntries() {
  uint32_t now = millis();
  for (int i = 0; i < MAX_BLE_PHONES; i++) {
    if (blePhones[i].active && (now - blePhones[i].lastSeenMs > NODE_STALE_MS * 2)) {
      blePhones[i].active = false;
      topologyDirty = true;
    }
  }
  for (int i = 0; i < MAX_ESPNOW_NEIGHBORS; i++) {
    if (espNeighbors[i].active && (now - espNeighbors[i].lastSeenMs > NODE_STALE_MS)) {
      espNeighbors[i].active = false;
      topologyDirty = true;
    }
  }
}

static int readBatteryPercent() {
#if ENABLE_BATTERY_MONITOR && (BATTERY_ADC_PIN >= 0)
  uint32_t mv = analogReadMilliVolts(BATTERY_ADC_PIN) * 2; // Assumes 100k/100k divider
  int pct = (int)(((long)mv - 3300L) * 100L / (4200L - 3300L));
  return constrain(pct, 0, 100);
#else
  return 100; // USB / mains / unmonitored regulated power
#endif
}

static String buildLsaPacketJson(String& outMsgId) {
  String neighborsJson = "[";
  bool first = true;
  for (int i = 0; i < MAX_BLE_PHONES; i++) {
    if (blePhones[i].active) {
      if (!first) neighborsJson += ",";
      neighborsJson += "{\"nodeId\":\"" + blePhones[i].nodeId + "\",\"name\":\"" +
                       blePhones[i].name + "\",\"rssi\":-58}";
      first = false;
    }
  }
  for (int i = 0; i < MAX_ESPNOW_NEIGHBORS; i++) {
    if (espNeighbors[i].active) {
      if (!first) neighborsJson += ",";
      neighborsJson += "{\"nodeId\":\"" + espNeighbors[i].nodeId + "\",\"name\":\"" +
                       espNeighbors[i].name + "\",\"rssi\":" + String((int)espNeighbors[i].rssi) + "}";
      first = false;
    }
  }
  neighborsJson += "]";
  if (first) return "";

  lsaSequence++;
  uint64_t ts = currentTimestampMs();
  String tsStr = u64ToString(ts);
  outMsgId = myNodeId + "-LSA-" + String(lsaSequence);

  String lsaObj = "{\"type\":\"LSA\",\"originNodeId\":\"" + myNodeId + "\",\"originName\":\"" +
                  myNodeName + "\",\"sequenceNumber\":" + String(lsaSequence) +
                  ",\"neighbors\":" + neighborsJson + ",\"timestamp\":" + tsStr + "}";

  String escapedLsa = lsaObj;
  escapedLsa.replace("\"", "\\\"");

  String checksum = computeAdlerChecksum(outMsgId + "|" + myNodeId + "|__ROUTING_CONTROL__|" + tsStr + "|" + lsaObj);
  String authTag = computeHmacSha256Hex(outMsgId + "|" + myNodeId + "|__ROUTING_CONTROL__|" + tsStr);

  return "{\"messageId\":\"" + outMsgId + "\",\"senderId\":\"" + myNodeId +
         "\",\"senderName\":\"" + myNodeName +
         "\",\"destinationId\":\"__ROUTING_CONTROL__\",\"timestamp\":" + tsStr +
         ",\"ttl\":8,\"priority\":\"NORMAL\",\"messageType\":\"ROUTING\",\"payload\":\"" +
         escapedLsa + "\",\"hopCount\":0,\"checksum\":\"" + checksum +
         "\",\"authTag\":\"" + authTag + "\",\"visitedNodes\":[\"" + myNodeId + "\"]}";
}

static String buildNodeStatusJson(String& outMsgId, int bleActiveCount, int outboxSize) {
  statusSequence++;
  uint64_t ts = currentTimestampMs();
  String tsStr = u64ToString(ts);
  outMsgId = myNodeId + "-STAT-" + String(statusSequence);

  String statusPayload = "{\"type\":\"NODE_STATUS\",\"nodeId\":\"" + myNodeId +
                         "\",\"name\":\"" + myNodeName +
                         "\",\"bleClients\":" + String(bleActiveCount) +
                         ",\"espNowPeers\":" + String(countActiveEspNeighbors()) +
                         ",\"queueSize\":" + String(outboxSize) +
                         ",\"relayed\":" + String(relayStats.relayedPackets) +
                         ",\"dropped\":" + String(relayStats.droppedInvalid) +
                         ",\"batteryPct\":" + String(readBatteryPercent()) +
                         ",\"sdReady\":" + String(relayStats.sdReady ? "true" : "false") +
                         ",\"mapServer\":" + String(relayStats.mapServerActive ? "true" : "false") +
                         ",\"freeHeap\":" + String(ESP.getFreeHeap()) +
                         ",\"uptimeSec\":" + String(millis() / 1000) + "}";

  String escaped = statusPayload;
  escaped.replace("\"", "\\\"");

  String checksum = computeAdlerChecksum(outMsgId + "|" + myNodeId + "|BROADCAST|" + tsStr + "|" + statusPayload);
  return "{\"messageId\":\"" + outMsgId + "\",\"senderId\":\"" + myNodeId +
         "\",\"senderName\":\"" + myNodeName +
         "\",\"destinationId\":\"BROADCAST\",\"timestamp\":" + tsStr +
         ",\"ttl\":4,\"priority\":\"NORMAL\",\"messageType\":\"NODE_STATUS\",\"payload\":\"" +
         escaped + "\",\"hopCount\":0,\"checksum\":\"" + checksum +
         "\",\"visitedNodes\":[\"" + myNodeId + "\"]}";
}

#endif

