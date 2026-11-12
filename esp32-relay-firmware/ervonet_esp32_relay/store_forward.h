#ifndef ERVONET_STORE_FORWARD_H
#define ERVONET_STORE_FORWARD_H

#include "config.h"
#include "protocol.h"
#include "routing_table.h"
#include "comm_ble.h"
#include "comm_espnow.h"
#include <LittleFS.h>

// ============================================================================
// STORE-AND-FORWARD PRIORITY QUEUE (With LittleFS Persistent SOS Backup)
// ============================================================================
struct OutboxItem {
  bool active;
  String msgId;
  String destId;
  String rawJson;
  uint8_t priorityRank; // 3 = CRITICAL_SOS, 2 = URGENT, 1 = NORMAL
  bool isBroadcast;
  bool waitingBleDelivery; // True if packet reached final relay and waits for dest phone BLE reconnect
  uint8_t retryCount;
  uint32_t createdMs;
  uint32_t expiresMs;
  uint32_t nextRetryMs;
};

static OutboxItem outboxQueue[OUTBOX_MAX_SLOTS];

static int getOutboxCount() {
  int cnt = 0;
  for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
    if (outboxQueue[i].active) cnt++;
  }
  return cnt;
}

static void persistSosQueueToFlash() {
#if ENABLE_PERSISTENT_SOS
  if (!relayStats.littleFsReady) return;
  File f = LittleFS.open(PERSISTENT_SOS_PATH, "w");
  if (!f) return;
  for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
    if (outboxQueue[i].active && outboxQueue[i].priorityRank >= 3) {
      f.print(outboxQueue[i].msgId);
      f.print('\t');
      f.print(outboxQueue[i].destId);
      f.print('\t');
      f.print(outboxQueue[i].isBroadcast ? "1" : "0");
      f.print('\t');
      f.println(outboxQueue[i].rawJson);
    }
  }
  f.close();
#endif
}

static void initPersistentSosStorage() {
#if ENABLE_PERSISTENT_SOS
  if (!LittleFS.begin(true)) {
    Serial.println("[PERSIST] LittleFS unavailable; running RAM-only Store-and-Forward");
    relayStats.littleFsReady = false;
    return;
  }
  relayStats.littleFsReady = true;

  if (!LittleFS.exists(PERSISTENT_SOS_PATH)) {
    Serial.println("[PERSIST] LittleFS mounted (0 saved SOS entries)");
    return;
  }

  File f = LittleFS.open(PERSISTENT_SOS_PATH, "r");
  if (!f) return;

  int restored = 0;
  uint32_t now = millis();
  while (f.available() && restored < OUTBOX_MAX_SLOTS) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    int t1 = line.indexOf('\t');
    int t2 = (t1 != -1) ? line.indexOf('\t', t1 + 1) : -1;
    int t3 = (t2 != -1) ? line.indexOf('\t', t2 + 1) : -1;
    if (t1 == -1 || t2 == -1 || t3 == -1) continue;

    outboxQueue[restored].active = true;
    outboxQueue[restored].msgId = line.substring(0, t1);
    outboxQueue[restored].destId = line.substring(t1 + 1, t2);
    outboxQueue[restored].isBroadcast = (line.substring(t2 + 1, t3) == "1");
    outboxQueue[restored].rawJson = line.substring(t3 + 1);
    outboxQueue[restored].priorityRank = 3;
    outboxQueue[restored].waitingBleDelivery = false;
    outboxQueue[restored].retryCount = 0;
    outboxQueue[restored].createdMs = now;
    outboxQueue[restored].expiresMs = now + OUTBOX_SOS_TTL_MS;
    outboxQueue[restored].nextRetryMs = now + 1500;
    restored++;
  }
  f.close();
  Serial.printf("[PERSIST] LittleFS restored %d CRITICAL_SOS packets across reboot\n", restored);
#endif
}

static void markOutboxAcknowledged(const String& ackedMsgId) {
  if (ackedMsgId.length() == 0) return;
  bool changed = false;
  if (takeStateLock()) {
    for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
      if (outboxQueue[i].active && outboxQueue[i].msgId == ackedMsgId) {
        if (outboxQueue[i].priorityRank >= 3) changed = true;
        outboxQueue[i].active = false;
        outboxQueue[i].rawJson = "";
        Serial.printf("[OUTBOX] Purged ACKed message %s\n", ackedMsgId.c_str());
      }
    }
    giveStateLock();
  }
  if (changed) persistSosQueueToFlash();
}

static void enqueueOutbox(const String& msgId, const String& destId, const String& rawJson,
                          uint8_t prioRank, bool isBroadcast, bool waitingBleDelivery) {
  if (msgId.length() == 0 || rawJson.length() == 0 || rawJson.length() > MAX_PACKET_JSON_LEN) return;

  bool addedSos = false;
  if (!takeStateLock()) return;

  for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
    if (outboxQueue[i].active && outboxQueue[i].msgId == msgId) {
      giveStateLock();
      return;
    }
  }

  int targetSlot = -1;
  for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
    if (!outboxQueue[i].active) {
      targetSlot = i;
      break;
    }
  }

  // If full, evict oldest lowest-priority entry (never evict CRITICAL_SOS unless all slots are SOS)
  if (targetSlot == -1) {
    uint8_t lowestPrio = 255;
    uint32_t oldestTs = 0xFFFFFFFFUL;
    for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
      if (outboxQueue[i].priorityRank < lowestPrio ||
          (outboxQueue[i].priorityRank == lowestPrio && outboxQueue[i].createdMs < oldestTs)) {
        lowestPrio = outboxQueue[i].priorityRank;
        oldestTs = outboxQueue[i].createdMs;
        targetSlot = i;
      }
    }
    if (targetSlot != -1) {
      if (outboxQueue[targetSlot].priorityRank > prioRank) {
        giveStateLock();
        return;
      }
      relayStats.outboxEvicted++;
    }
  }

  if (targetSlot != -1) {
    uint32_t now = millis();
    uint32_t ttlWindow = (prioRank >= 3) ? OUTBOX_SOS_TTL_MS : OUTBOX_NORMAL_TTL_MS;

    outboxQueue[targetSlot].active = true;
    outboxQueue[targetSlot].msgId = msgId;
    outboxQueue[targetSlot].destId = destId;
    outboxQueue[targetSlot].rawJson = rawJson;
    outboxQueue[targetSlot].priorityRank = prioRank;
    outboxQueue[targetSlot].isBroadcast = isBroadcast;
    outboxQueue[targetSlot].waitingBleDelivery = waitingBleDelivery;
    outboxQueue[targetSlot].retryCount = 0;
    outboxQueue[targetSlot].createdMs = now;
    outboxQueue[targetSlot].expiresMs = now + ttlWindow;
    outboxQueue[targetSlot].nextRetryMs = now + 2000;
    addedSos = (prioRank >= 3);

    Serial.printf("[OUTBOX] Queued %s -> %s (prio=%u, bleWait=%d, total=%d)\n",
                  msgId.c_str(), destId.c_str(), prioRank, waitingBleDelivery ? 1 : 0, getOutboxCount());
  }
  giveStateLock();

  if (addedSos) persistSosQueueToFlash();
}

static void flushOutbox(bool forceUrgent = false) {
  uint32_t now = millis();
  int espPeers = countActiveEspNeighbors();
  bool dirtyFlash = false;

  for (uint8_t targetPrio = 3; targetPrio >= 1; targetPrio--) {
    for (int i = 0; i < OUTBOX_MAX_SLOTS; i++) {
      if (!takeStateLock()) continue;
      OutboxItem snapshot = outboxQueue[i];
      if (!snapshot.active || snapshot.priorityRank != targetPrio) {
        giveStateLock();
        continue;
      }

      if ((int32_t)(now - snapshot.expiresMs) >= 0) {
        if (snapshot.priorityRank >= 3) dirtyFlash = true;
        outboxQueue[i].active = false;
        outboxQueue[i].rawJson = "";
        giveStateLock();
        Serial.printf("[OUTBOX] Expired %s after TTL\n", snapshot.msgId.c_str());
        continue;
      }

      if (!forceUrgent && (int32_t)(now - snapshot.nextRetryMs) < 0) {
        giveStateLock();
        continue;
      }
      bool phoneReady = hasBlePhone(snapshot.destId) && (bleClientCount > 0);
      giveStateLock();

      bool deliveredNow = false;
      if (phoneReady) {
        deliveredNow = sendJsonOverBle(snapshot.rawJson, snapshot.msgId);
        if (deliveredNow) {
          relayStats.deliveredLocalBle++;
          Serial.printf("[OUTBOX] Delivered stored packet %s to reconnected BLE phone %s\n",
                        snapshot.msgId.c_str(), snapshot.destId.c_str());
        }
      } else if (snapshot.isBroadcast && (bleClientCount > 0 || espPeers > 0)) {
        if (bleClientCount > 0) deliveredNow = sendJsonOverBle(snapshot.rawJson, snapshot.msgId);
        if (espPeers > 0) deliveredNow = sendJsonOverEspNow(snapshot.rawJson, snapshot.msgId) || deliveredNow;
      } else if (!snapshot.waitingBleDelivery && espPeers > 0) {
        deliveredNow = sendJsonOverEspNow(snapshot.rawJson, snapshot.msgId);
        if (deliveredNow) {
          relayStats.relayedPackets++;
          Serial.printf("[OUTBOX] Forwarded stored packet %s to ESP-NOW neighbor\n", snapshot.msgId.c_str());
        }
      }

      if (takeStateLock()) {
        if (outboxQueue[i].active && outboxQueue[i].msgId == snapshot.msgId) {
          if (deliveredNow) {
            if (outboxQueue[i].priorityRank >= 3 && outboxQueue[i].retryCount < 2 && outboxQueue[i].isBroadcast) {
              outboxQueue[i].retryCount++;
              outboxQueue[i].nextRetryMs = now + 8000;
            } else {
              if (outboxQueue[i].priorityRank >= 3) dirtyFlash = true;
              outboxQueue[i].active = false;
              outboxQueue[i].rawJson = "";
            }
          } else {
            outboxQueue[i].retryCount++;
            if (outboxQueue[i].retryCount >= OUTBOX_MAX_RETRIES && outboxQueue[i].priorityRank < 3) {
              outboxQueue[i].active = false;
              outboxQueue[i].rawJson = "";
            } else {
              uint32_t backoffMs = min((uint32_t)30000, (uint32_t)(2500 * outboxQueue[i].retryCount));
              outboxQueue[i].nextRetryMs = now + backoffMs;
            }
          }
        }
        giveStateLock();
      }
    }
  }

  if (dirtyFlash) persistSosQueueToFlash();
}

#endif
