/**
 * ERVONET — Hybrid BLE + ESP-NOW Disaster Communication & Local PMTiles Map Hub
 * Architecture:
 *   Smartphone A <--[BLE GATT]--> ESP32 Node 1 <--[ESP-NOW]--> ESP32 Node 2 <--[BLE GATT]--> Smartphone B
 *   On-Demand Map Hub: Mobile <--[BLE MAP_SERVER_CMD / SoftAP Ch.1 HTTP 206]--> SD /maps/region.pmtiles
 *
 * Modules (must remain in the same folder as this .ino):
 *   - config.h        : Node ID, pins (LED/SOS/Buzzer/ADC/SD SPI), UUIDs, mutexes, PSK toggles
 *   - protocol.h      : Adler-32 checksum, HMAC-SHA256, SHA256-CTR, JSON & ReassemblySlot
 *   - routing_table.h : BLE phone registry, ESP-NOW neighbors (RSSI), LSA & NODE_STATUS telemetry
 *   - comm_espnow.h   : Wi-Fi Ch.1 STA setup, Core 2.x/3.x ISR queue, mutex-safe 250B framing
 *   - comm_ble.h      : BLE GATT Server (0xFE20..0xFE23 / 0x05F9), mutex-safe RESQ_CHUNK framing
 *   - store_forward.h : 24-slot priority queue + internal LittleFS CRITICAL_SOS reboot backup
 *   - map_server.h    : On-demand SoftAP ERVONET-MAP-HUB + HTTP 206 Partial Content MicroSD server
 *
 * Arduino IDE Settings:
 *   - Board            : ESP32 Dev Module
 *   - Partition Scheme : Huge APP (3MB No OTA/1MB SPIFFS)
 *   - Serial Monitor   : 115200 baud (STATUS, PEERS, OUTBOX, SOS, MAP ON, MAP OFF)
 */

#include "config.h"
#include "protocol.h"
#include "routing_table.h"
#include "comm_espnow.h"
#include "comm_ble.h"
#include "store_forward.h"
#include "map_server.h"

// ============================================================================
// RUNTIME TIMERS & HARDWARE STATE (Pinned Core 0: ESP-NOW+Map | Core 1: BLE+Mesh)
// ============================================================================
static uint32_t txPacketsCount = 0;
static TaskHandle_t core0TaskHandle = nullptr;

static unsigned long lastBeaconMs = 0;
static unsigned long lastLsaMs = 0;
static unsigned long lastStatusMs = 0;
static unsigned long lastOutboxFlushMs = 0;

// Non-blocking Status LED Pattern Engine
static unsigned long ledFlashUntilMs = 0;
static unsigned long sosAlertUntilMs = 0;
static unsigned long lastLedPatternMs = 0;
static bool ledPatternState = false;

// Pushbutton short/long press tracking (GPIO 4 -> GND)
static bool lastButtonState = HIGH;
static unsigned long buttonDownMs = 0;
static bool longPressHandled = false;

// ============================================================================
// NON-BLOCKING LED STATUS ENGINE & BUZZER INDICATOR
// ============================================================================
static void pulseBuzzer(int beeps, int onMs = 80, int offMs = 60) {
  if (BUZZER_PIN < 0) return;
  for (int i = 0; i < beeps; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(onMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < beeps - 1) delay(offMs);
  }
}

static void triggerActivityFlash(unsigned long durationMs = 60) {
  ledFlashUntilMs = millis() + durationMs;
  digitalWrite(LED_STATUS_PIN, HIGH);
}

static RelayLedMode resolveLedMode(unsigned long now) {
  if ((long)(sosAlertUntilMs - now) > 0) return LED_MODE_SOS_ALERT;
  if (relayStats.mapServerActive) return LED_MODE_MAP_SERVER;
  if (bleClientCount > 0) return LED_MODE_BLE_CONNECTED;
  if (countActiveEspNeighbors() > 0) return LED_MODE_ESPNOW_ACTIVE;
  return LED_MODE_IDLE;
}

static void updateStatusLedPattern() {
  unsigned long now = millis();
  if ((long)(ledFlashUntilMs - now) > 0) {
    digitalWrite(LED_STATUS_PIN, HIGH);
    return;
  }

  RelayLedMode mode = resolveLedMode(now);
  unsigned long onPeriod = 30;
  unsigned long offPeriod = 2970;

  if (mode == LED_MODE_SOS_ALERT) {
    onPeriod = 80; offPeriod = 80;
  } else if (mode == LED_MODE_MAP_SERVER) {
    onPeriod = 140; offPeriod = 140;
  } else if (mode == LED_MODE_BLE_CONNECTED) {
    onPeriod = 120; offPeriod = 1200;
  } else if (mode == LED_MODE_ESPNOW_ACTIVE) {
    onPeriod = 60; offPeriod = 1800;
  }

  unsigned long elapsed = now - lastLedPatternMs;
  if (ledPatternState && elapsed >= onPeriod) {
    ledPatternState = false;
    lastLedPatternMs = now;
    digitalWrite(LED_STATUS_PIN, LOW);
  } else if (!ledPatternState && elapsed >= offPeriod) {
    ledPatternState = true;
    lastLedPatternMs = now;
    digitalWrite(LED_STATUS_PIN, HIGH);
  }
}

// ============================================================================
// IDENTITY INITIALIZATION (Deterministic from ESP32 eFuse MAC unless overridden)
// ============================================================================
static void initIdentity() {
  uint64_t chipMac = ESP.getEfuseMac();
  uint8_t b4 = (uint8_t)(chipMac >> 32);
  uint8_t b5 = (uint8_t)(chipMac >> 40);

  String suffix = String(CUSTOM_NODE_SUFFIX);
  suffix.trim();
  suffix.toUpperCase();
  if (suffix.length() != 4) {
    char buf[8];
    snprintf(buf, sizeof(buf), "ES%02X", (unsigned int)(b4 ^ b5));
    suffix = String(buf);
  }

  myNodeId = "ERVO-" + suffix;
  myNodeName = "ESP32-Relay-" + suffix.substring(2);
}

// ============================================================================
// PERIODIC CONTROL-PLANE BROADCASTS (LSA + NODE_STATUS)
// ============================================================================
static void sendLsaPacket() {
  String msgId = "";
  String pkt = "";
  if (takeStateLock()) {
    pkt = buildLsaPacketJson(msgId);
    topologyDirty = false;
    giveStateLock();
  }
  if (pkt.length() == 0) return;

  markMessageSeen(msgId);
  sendJsonOverBle(pkt, msgId);
  sendJsonOverEspNow(pkt, msgId);
}

static void sendNodeStatusPacket() {
  if (bleClientCount == 0 && countActiveEspNeighbors() == 0) return;
  String msgId = "";
  String pkt = "";
  if (takeStateLock()) {
    pkt = buildNodeStatusJson(msgId, (int)bleClientCount, getOutboxCount());
    giveStateLock();
  }
  if (pkt.length() == 0) return;

  markMessageSeen(msgId);
  sendJsonOverBle(pkt, msgId);
  sendJsonOverEspNow(pkt, msgId);
}

// ============================================================================
// CORE HYBRID ROUTER & RELAY ENGINE (Thread-safe across Core 0 & Core 1)
// ============================================================================
void handleCompletePacket(const String& rawJson, bool fromBle) {
  if (rawJson.length() < 20 || rawJson[0] != '{') return;

  String msgId = extractJsonString(rawJson, "messageId");
  String senderId = extractJsonString(rawJson, "senderId");
  String senderName = extractJsonString(rawJson, "senderName");
  String destId = extractJsonString(rawJson, "destinationId");
  String msgType = extractJsonString(rawJson, "messageType");
  String priority = extractJsonString(rawJson, "priority");
  String payload = extractJsonString(rawJson, "payload");
  long long ttl = extractJsonInt(rawJson, "ttl", 10);
  long long hopCount = extractJsonInt(rawJson, "hopCount", 0);
  long long pktTs = extractJsonInt(rawJson, "timestamp", 0);

  if (msgId.length() == 0 || senderId.length() == 0) {
    relayStats.droppedInvalid++;
    return;
  }

  if (pktTs > 1600000000000LL) {
    epochOffsetMs = pktTs - (int64_t)millis();
  }

  if (senderId.equalsIgnoreCase(myNodeId)) return;

  if (!validatePacketIntegrity(rawJson, msgId, senderId, destId, pktTs, payload)) {
    relayStats.droppedInvalid++;
    return;
  }

  if (fromBle && !senderId.startsWith("ERVO-ES") && !senderId.startsWith("RESQ-ES")) {
    if (takeStateLock()) {
      upsertBlePhone(senderId, senderName);
      giveStateLock();
    }
  }

  // Handle On-Demand Offline Map Server commands from connected phone over BLE
  if (fromBle && msgType == "MAP_SERVER_CMD") {
    markMessageSeen(msgId);
    if (payload.indexOf("START") != -1) {
      startMapServer();
    } else if (payload.indexOf("STOP") != -1) {
      stopMapServer();
    }
    String statusId = "";
    String statusJson = buildMapServerStatusJson(statusId, senderId);
    sendJsonOverBle(statusJson, statusId);
    return;
  }

  // Direct BLE Handshake + Instant Store-and-Forward Flush for reconnected phone
  if (fromBle && msgType == "PING" && payload.startsWith("HANDSHAKE:") &&
      !payload.startsWith("HANDSHAKE_REPLY:")) {
    markMessageSeen(msgId);
    uint64_t ts = currentTimestampMs();
    String tsStr = u64ToString(ts);
    String replyId = myNodeId + "-HS-" + String(millis());
    String replyPayload = "HANDSHAKE_REPLY:" + myNodeName;
    String chk = computeAdlerChecksum(replyId + "|" + myNodeId + "|" + senderId + "|" + tsStr + "|" + replyPayload);
    String replyJson = "{\"messageId\":\"" + replyId + "\",\"senderId\":\"" + myNodeId +
                       "\",\"senderName\":\"" + myNodeName + "\",\"destinationId\":\"" + senderId +
                       "\",\"timestamp\":" + tsStr +
                       ",\"ttl\":1,\"priority\":\"NORMAL\",\"messageType\":\"PING\",\"payload\":\"" +
                       replyPayload + "\",\"hopCount\":0,\"checksum\":\"" + chk + "\"}";
    sendJsonOverBle(replyJson, replyId);
    topologyDirty = true;
    flushOutbox(true);
    return;
  }

  // Duplicate suppression
  if (takeStateLock()) {
    if (isMessageSeen(msgId)) {
      relayStats.droppedDuplicate++;
      giveStateLock();
      return;
    }
    markMessageSeen(msgId);
    giveStateLock();
  }

  // Delivery ACK cleanup in Store-and-Forward + LittleFS backup
  if (msgType == "ACK" && payload.startsWith("ACK:")) {
    markOutboxAcknowledged(payload.substring(4));
  }

  if (jsonArrayContains(rawJson, "visitedNodes", myNodeId)) return;
  if (ttl <= 1 && !hasBlePhone(destId)) return;

  uint8_t prioRank = priorityRank(priority);
  bool isSos = (prioRank >= 3) || (msgType == "SOS");

  String relayed = rawJson;
  relayed = setOrUpdateJsonInt(relayed, "ttl", ttl > 1 ? ttl - 1 : 1);
  relayed = setOrUpdateJsonInt(relayed, "hopCount", hopCount + 1);
  long long routeIdx = extractJsonInt(rawJson, "routeIndex", -1);
  if (routeIdx >= 0) {
    relayed = setOrUpdateJsonInt(relayed, "routeIndex", routeIdx + 1);
  }
  relayed = appendToVisitedNodes(relayed, myNodeId);

  relayStats.relayedPackets++;
  Serial.printf("[RELAY #%lu] %s -> %s | type=%s prio=%u ttl=%ld hop=%ld via=%s\n",
                (unsigned long)relayStats.relayedPackets, senderId.c_str(), destId.c_str(),
                msgType.c_str(), prioRank, (long)(ttl - 1), (long)(hopCount + 1),
                fromBle ? "BLE" : "ESP-NOW");

  if (isSos) {
    sosAlertUntilMs = millis() + 6000;
    pulseBuzzer(2, 60, 40);
  } else {
    triggerActivityFlash(75);
  }

  bool isBroadcast = (destId == "BROADCAST" || destId == "#all" || destId.startsWith("#") ||
                      destId == "__ROUTING_CONTROL__" || msgType == "ROUTING" ||
                      msgType == "NODE_STATUS" || msgType == "ROUTE_UPDATE");

  if (isBroadcast) {
    if (bleClientCount > 0) sendJsonOverBle(relayed, msgId);
    bool sentEsp = (ttl > 1 && countActiveEspNeighbors() > 0) ? sendJsonOverEspNow(relayed, msgId) : false;
    if (!sentEsp && isSos && msgType != "ROUTING") {
      enqueueOutbox(msgId, destId, relayed, prioRank, true, false);
    }
    return;
  }

  if (hasBlePhone(destId)) {
    if (bleClientCount > 0 && sendJsonOverBle(relayed, msgId)) {
      relayStats.deliveredLocalBle++;
    } else {
      enqueueOutbox(msgId, destId, relayed, prioRank, false, true);
    }
    return;
  }

  bool sentEsp = (ttl > 1 && countActiveEspNeighbors() > 0) ? sendJsonOverEspNow(relayed, msgId) : false;
  bool sentBle = (!fromBle && bleClientCount > 0) ? sendJsonOverBle(relayed, msgId) : false;

  if (!sentEsp && (!sentBle || fromBle)) {
    enqueueOutbox(msgId, destId, relayed, prioRank, false, false);
  } else if (!fromBle && bleClientCount == 0) {
    enqueueOutbox(msgId, destId, relayed, prioRank, false, false);
  }
}

// ============================================================================
// PHYSICAL HARDWARE SOS & MAP SERVER TOGGLE BUTTON (GPIO 4 -> GND)
// Short press (50..2499ms) = SOS Broadcast | Long press (>= 2500ms) = Map AP
// ============================================================================
static void triggerHardwareSos(const char* sourceLabel) {
  uint64_t ts = currentTimestampMs();
  String tsStr = u64ToString(ts);
  txPacketsCount++;
  String msgId = myNodeId + "-SOS-" + String(txPacketsCount);
  String rawPayload = String("[CRITICAL SOS]: ") + sourceLabel + " trigger activated on " + myNodeName + "!";
  String wirePayload = rawPayload;
  bool isEncrypted = false;

  if (ENABLE_APP_ENCRYPTION) {
    wirePayload = encryptTextToHex(rawPayload, msgId);
    isEncrypted = true;
  }

  String chk = computeAdlerChecksum(msgId + "|" + myNodeId + "|BROADCAST|" + tsStr + "|" + wirePayload);
  String authTag = computeHmacSha256Hex(msgId + "|" + myNodeId + "|BROADCAST|" + tsStr);

  String pkt = "{\"messageId\":\"" + msgId + "\",\"senderId\":\"" + myNodeId +
               "\",\"senderName\":\"" + myNodeName + "\",\"destinationId\":\"BROADCAST\",\"timestamp\":" +
               tsStr + ",\"ttl\":10,\"priority\":\"CRITICAL_SOS\",\"messageType\":\"ALERT\",\"payload\":\"" +
               wirePayload + "\",\"hopCount\":0,\"checksum\":\"" + chk +
               "\",\"authTag\":\"" + authTag + "\"" +
               (isEncrypted ? ",\"encrypted\":true" : "") +
               ",\"visitedNodes\":[\"" + myNodeId + "\"]}";

  markMessageSeen(msgId);
  sosAlertUntilMs = millis() + 6000;
  Serial.printf("[SOS] Broadcasting %s emergency alert (%s)\n", myNodeName.c_str(), msgId.c_str());

  bool sentBle = (bleClientCount > 0) ? sendJsonOverBle(pkt, msgId) : false;
  bool sentEsp = (countActiveEspNeighbors() > 0) ? sendJsonOverEspNow(pkt, msgId) : false;
  if (!sentBle || !sentEsp) {
    enqueueOutbox(msgId, "BROADCAST", pkt, 3, true, false);
  }
  pulseBuzzer(3, 90, 50);
}

static void checkHardwareButton() {
  bool reading = digitalRead(SOS_BUTTON_PIN);
  unsigned long now = millis();

  if (reading == LOW && lastButtonState == HIGH) {
    buttonDownMs = now;
    longPressHandled = false;
  } else if (reading == LOW && !longPressHandled && (now - buttonDownMs >= MAP_LONG_PRESS_MS)) {
    longPressHandled = true;
    if (relayStats.mapServerActive) {
      stopMapServer();
    } else {
      startMapServer();
    }
    String statusId = "";
    String statusJson = buildMapServerStatusJson(statusId, "BROADCAST");
    sendJsonOverBle(statusJson, statusId);
    pulseBuzzer(1, 140, 0);
  } else if (reading == HIGH && lastButtonState == LOW) {
    unsigned long held = now - buttonDownMs;
    if (!longPressHandled && held >= 50) {
      triggerHardwareSos("Hardware SOS button");
    }
  }
  lastButtonState = reading;
}

// ============================================================================
// FREERTOS CORE 0 TASK: ESP-NOW DISCOVERY + ON-DEMAND PMTILES SOFTAP SERVER
// ============================================================================
static void espNowAndMapTask(void* param) {
  (void)param;
  for (;;) {
    drainEspNowQueue();
    serviceMapServer();

    unsigned long now = millis();
    if (now - lastBeaconMs >= BEACON_INTERVAL_MS) {
      lastBeaconMs = now;
      if (takeStateLock()) {
        pruneStaleEntries();
        giveStateLock();
      }
      sendEspNowBeacon();
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// ============================================================================
// SERIAL MONITOR DIAGNOSTIC CONSOLE
// ============================================================================
static void printRelayDiagnostics() {
  Serial.println("\n--- ERVONET RELAY & MAP HUB STATUS ---");
  Serial.printf("Node: %s (%s) | Ch: %d | MAC: %s\n",
                myNodeName.c_str(), myNodeId.c_str(), WIFI_MESH_CHANNEL, WiFi.macAddress().c_str());
  Serial.printf("BLE Clients: %u | Phones: %d | ESP-NOW Peers: %d\n",
                (unsigned int)bleClientCount, countRegisteredBlePhones(), countActiveEspNeighbors());
  Serial.printf("SD: %s | PMTiles: %llu bytes (valid=%d) | Map AP: %s | LittleFS: %s\n",
                relayStats.sdReady ? "READY" : "NONE",
                (unsigned long long)relayStats.mapFileSizeBytes,
                relayStats.mapValidHeader ? 1 : 0,
                relayStats.mapServerActive ? "ACTIVE (192.168.4.1)" : "OFF",
                relayStats.littleFsReady ? "READY" : "NONE");
  Serial.printf("Stats: rxBLE=%lu rxESP=%lu relayed=%lu localBLE=%lu dup=%lu invalid=%lu evicted=%lu\n",
                (unsigned long)relayStats.rxBlePackets, (unsigned long)relayStats.rxEspNowPackets,
                (unsigned long)relayStats.relayedPackets, (unsigned long)relayStats.deliveredLocalBle,
                (unsigned long)relayStats.droppedDuplicate, (unsigned long)relayStats.droppedInvalid,
                (unsigned long)relayStats.outboxEvicted);
  Serial.printf("Outbox Pending: %d/%d | Battery: %d%% | Free Heap: %u bytes | Uptime: %lus\n",
                getOutboxCount(), OUTBOX_MAX_SLOTS, readBatteryPercent(),
                (unsigned int)ESP.getFreeHeap(), (unsigned long)(millis() / 1000));
  Serial.println("--------------------------------------\n");
}

static void handleSerialDebugCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  cmd.toUpperCase();
  if (cmd == "STATUS") {
    printRelayDiagnostics();
  } else if (cmd == "PEERS") {
    Serial.println("[PEERS] Active BLE phones:");
    for (int i = 0; i < MAX_BLE_PHONES; i++) {
      if (blePhones[i].active) {
        Serial.printf("  - BLE: %s (%s)\n", blePhones[i].name.c_str(), blePhones[i].nodeId.c_str());
      }
    }
    Serial.println("[PEERS] Active ESP-NOW relays:");
    for (int i = 0; i < MAX_ESPNOW_NEIGHBORS; i++) {
      if (espNeighbors[i].active) {
        Serial.printf("  - ESP-NOW: %s (%s) RSSI=%d dBm\n",
                      espNeighbors[i].name.c_str(), espNeighbors[i].nodeId.c_str(), (int)espNeighbors[i].rssi);
      }
    }
  } else if (cmd == "OUTBOX") {
    Serial.printf("[OUTBOX] Pending items: %d\n", getOutboxCount());
    for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
      if (outboxQueue[i].active) {
        Serial.printf("  - %s -> %s (prio=%u retries=%u)\n",
                      outboxQueue[i].msgId.c_str(), outboxQueue[i].destId.c_str(),
                      outboxQueue[i].priorityRank, outboxQueue[i].retryCount);
      }
    }
  } else if (cmd == "SOS") {
    triggerHardwareSos("Serial test console");
  } else if (cmd == "MAP ON") {
    startMapServer();
    String sid = "";
    sendJsonOverBle(buildMapServerStatusJson(sid, "BROADCAST"), sid);
  } else if (cmd == "MAP OFF") {
    stopMapServer();
    String sid = "";
    sendJsonOverBle(buildMapServerStatusJson(sid, "BROADCAST"), sid);
  }
}

// ============================================================================
// ARDUINO SETUP & CORE 1 BLE / OUTBOX / HARDWARE LOOP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  stateMutex = xSemaphoreCreateMutex();
  bleTxMutex = xSemaphoreCreateMutex();
  espTxMutex = xSemaphoreCreateMutex();

  pinMode(LED_STATUS_PIN, OUTPUT);
  pinMode(SOS_BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_STATUS_PIN, LOW);

  if (BUZZER_PIN >= 0) {
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
  }
#if ENABLE_BATTERY_MONITOR && (BATTERY_ADC_PIN >= 0)
  pinMode(BATTERY_ADC_PIN, INPUT);
#endif

  initIdentity();
  Serial.println("\n================================================");
  Serial.printf("  ERVONET Relay + Map Hub Booting: %s (%s)\n", myNodeName.c_str(), myNodeId.c_str());
  Serial.println("================================================");

  initPersistentSosStorage();
  initMapStorage();
  initEspNow();
  initBleServer();
  sendEspNowBeacon();

  xTaskCreatePinnedToCore(
      espNowAndMapTask,
      "EspNowMapCore0",
      8192,
      nullptr,
      1,
      &core0TaskHandle,
      0);

  triggerActivityFlash(150);
  pulseBuzzer(1, 50, 0);
}

void loop() {
  drainBleQueue();
  checkHardwareButton();
  handleSerialDebugCommands();
  updateStatusLedPattern();

  unsigned long now = millis();

  if (topologyDirty || (now - lastLsaMs >= LSA_INTERVAL_MS)) {
    lastLsaMs = now;
    sendLsaPacket();
  }

  if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    sendNodeStatusPacket();
  }

  if (now - lastOutboxFlushMs >= OUTBOX_FLUSH_INTERVAL_MS) {
    lastOutboxFlushMs = now;
    if (getOutboxCount() > 0) {
      flushOutbox(false);
    }
  }

  delay(5);
}
