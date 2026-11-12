#ifndef ERVONET_MAP_SERVER_H
#define ERVONET_MAP_SERVER_H

#include "config.h"
#include "protocol.h"
#include <SPI.h>
#include <SD.h>
#include <WiFi.h>
#include <esp_wifi.h>

// ============================================================================
// ON-DEMAND OFFLINE PMTILES MAP SERVER (SoftAP on Ch.1 + HTTP 206 Byte-Range)
// Keeps Wi-Fi SoftAP OFF during normal BLE+ESP-NOW mesh routing to save
// airtime and battery; mounts /maps/region.pmtiles from SPI MicroSD on demand.
// ============================================================================
static WiFiServer mapHttpServer(80);
static unsigned long mapServerStartedMs = 0;
static unsigned long lastMapActivityMs = 0;

static void initMapStorage() {
  SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
  if (!SD.begin(SD_CS_PIN, SPI)) {
    Serial.println("[SD] MicroSD module not detected; offline PMTiles HTTP server disabled");
    relayStats.sdReady = false;
    relayStats.mapFileSizeBytes = 0;
    relayStats.mapValidHeader = false;
    return;
  }

  relayStats.sdReady = true;
  if (!SD.exists(MAP_PMTILES_PATH)) {
    Serial.printf("[SD] Mounted cleanly, but %s not found on card\n", MAP_PMTILES_PATH);
    relayStats.mapFileSizeBytes = 0;
    relayStats.mapValidHeader = false;
    return;
  }

  File f = SD.open(MAP_PMTILES_PATH, FILE_READ);
  if (f) {
    relayStats.mapFileSizeBytes = (uint64_t)f.size();
    uint8_t magic[7] = {0};
    if (f.read(magic, sizeof(magic)) == sizeof(magic)) {
      relayStats.mapValidHeader = (memcmp(magic, "PMTiles", 7) == 0);
    }
    f.close();
  }

  Serial.printf("[SD] PMTiles ready: %s (%llu bytes | magicValid=%d)\n",
                MAP_PMTILES_PATH, (unsigned long long)relayStats.mapFileSizeBytes,
                relayStats.mapValidHeader ? 1 : 0);
}

static bool startMapServer() {
  if (relayStats.mapServerActive) {
    lastMapActivityMs = millis();
    return true;
  }

  // Coexistence critical: stay in WIFI_AP_STA on exact same channel as ESP-NOW!
  WiFi.mode(WIFI_AP_STA);
  esp_wifi_set_ps(WIFI_PS_NONE);
  bool ok = WiFi.softAP(MAP_AP_SSID, MAP_AP_PASS, WIFI_MESH_CHANNEL, 0, 2);
  if (!ok) {
    Serial.println("[MAP-AP] Failed to start SoftAP");
    WiFi.mode(WIFI_STA);
    esp_wifi_set_channel(WIFI_MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);
    return false;
  }

  esp_wifi_set_channel(WIFI_MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);
  mapHttpServer.begin();
  relayStats.mapServerActive = true;
  mapServerStartedMs = millis();
  lastMapActivityMs = mapServerStartedMs;

  Serial.printf("[MAP-AP] STARTED SSID=\"%s\" IP=%s Ch=%d (Auto-off in %lus)\n",
                MAP_AP_SSID, WiFi.softAPIP().toString().c_str(), WIFI_MESH_CHANNEL,
                (unsigned long)(MAP_AP_IDLE_TIMEOUT_MS / 1000));
  return true;
}

static void stopMapServer() {
  if (!relayStats.mapServerActive) return;
  mapHttpServer.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_channel(WIFI_MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);
  relayStats.mapServerActive = false;
  Serial.println("[MAP-AP] STOPPED (Returned 100% radio airtime to BLE + ESP-NOW)");
}

static String buildMapServerStatusJson(String& outMsgId, const String& destId) {
  uint64_t ts = currentTimestampMs();
  String tsStr = u64ToString(ts);
  outMsgId = myNodeId + "-MAP-" + String(millis());

  unsigned long elapsed = relayStats.mapServerActive ? (millis() - lastMapActivityMs) : 0;
  unsigned long remSec = relayStats.mapServerActive && elapsed < MAP_AP_IDLE_TIMEOUT_MS
                           ? (MAP_AP_IDLE_TIMEOUT_MS - elapsed) / 1000
                           : 0;

  String ipStr = relayStats.mapServerActive ? WiFi.softAPIP().toString() : String("192.168.4.1");
  String payload = "{\"type\":\"MAP_SERVER_STATUS\",\"active\":" +
                   String(relayStats.mapServerActive ? "true" : "false") +
                   ",\"ssid\":\"" + String(MAP_AP_SSID) +
                   "\",\"password\":\"" + String(MAP_AP_PASS) +
                   "\",\"ip\":\"" + ipStr +
                   "\",\"channel\":" + String(WIFI_MESH_CHANNEL) +
                   ",\"url\":\"http://" + ipStr + "/maps/region.pmtiles\"" +
                   ",\"sizeBytes\":" + u64ToString(relayStats.mapFileSizeBytes) +
                   ",\"sdReady\":" + String(relayStats.sdReady ? "true" : "false") +
                   ",\"validPmTiles\":" + String(relayStats.mapValidHeader ? "true" : "false") +
                   ",\"expiresInSec\":" + String(remSec) + "}";

  String escaped = payload;
  escaped.replace("\"", "\\\"");

  String target = destId.length() > 0 ? destId : String("BROADCAST");
  String chk = computeAdlerChecksum(outMsgId + "|" + myNodeId + "|" + target + "|" + tsStr + "|" + payload);
  String authTag = computeHmacSha256Hex(outMsgId + "|" + myNodeId + "|" + target + "|" + tsStr);

  return "{\"messageId\":\"" + outMsgId + "\",\"senderId\":\"" + myNodeId +
         "\",\"senderName\":\"" + myNodeName +
         "\",\"destinationId\":\"" + target +
         "\",\"timestamp\":" + tsStr +
         ",\"ttl\":2,\"priority\":\"NORMAL\",\"messageType\":\"MAP_SERVER_CMD\",\"payload\":\"" +
         escaped + "\",\"hopCount\":0,\"checksum\":\"" + chk +
         "\",\"authTag\":\"" + authTag + "\"}";
}

static void streamSdRangeResponse(WiFiClient& client, bool headOnly, bool hasRange,
                                  uint64_t rangeStart, uint64_t rangeEnd) {
  if (!relayStats.sdReady || !SD.exists(MAP_PMTILES_PATH)) {
    client.println("HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nregion.pmtiles not present on MicroSD.");
    return;
  }

  File f = SD.open(MAP_PMTILES_PATH, FILE_READ);
  if (!f) {
    client.println("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\nSD open failed.");
    return;
  }

  uint64_t totalSize = (uint64_t)f.size();
  if (totalSize == 0) {
    f.close();
    client.println("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nEmpty file.");
    return;
  }

  uint64_t start = hasRange ? rangeStart : 0;
  uint64_t end = hasRange ? rangeEnd : (totalSize - 1);
  if (end >= totalSize) end = totalSize - 1;
  if (start > end || start >= totalSize) {
    f.close();
    client.printf("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */%llu\r\nConnection: close\r\n\r\n",
                  (unsigned long long)totalSize);
    return;
  }

  uint64_t contentLen = (end - start) + 1;
  client.println(hasRange ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK");
  client.println("Content-Type: application/vnd.pmtiles");
  client.println("Accept-Ranges: bytes");
  client.println("Access-Control-Allow-Origin: *");
  if (hasRange) {
    client.printf("Content-Range: bytes %llu-%llu/%llu\r\n",
                  (unsigned long long)start, (unsigned long long)end, (unsigned long long)totalSize);
  }
  client.printf("Content-Length: %llu\r\n", (unsigned long long)contentLen);
  client.println("Connection: close");
  client.println();

  if (!headOnly) {
    f.seek((size_t)start);
    uint8_t buf[4096];
    uint64_t remaining = contentLen;
    while (remaining > 0 && client.connected()) {
      size_t toRead = (size_t)min((uint64_t)sizeof(buf), remaining);
      size_t readLen = f.read(buf, toRead);
      if (readLen == 0) break;
      client.write(buf, readLen);
      remaining -= readLen;
      lastMapActivityMs = millis();
      yield();
    }
  }
  f.close();
}

static void serviceMapServer() {
  if (!relayStats.mapServerActive) return;

  if (millis() - lastMapActivityMs >= MAP_AP_IDLE_TIMEOUT_MS) {
    stopMapServer();
    return;
  }

  WiFiClient client = mapHttpServer.available();
  if (!client) return;

  lastMapActivityMs = millis();
  unsigned long waitStart = millis();
  while (client.connected() && !client.available() && (millis() - waitStart < 1000)) {
    delay(2);
  }
  if (!client.available()) {
    client.stop();
    return;
  }

  String reqLine = client.readStringUntil('\n');
  reqLine.trim();

  bool hasRange = false;
  uint64_t rStart = 0;
  uint64_t rEnd = 0xFFFFFFFFFFFFFFFFULL;

  while (client.connected() && client.available()) {
    String hdr = client.readStringUntil('\n');
    hdr.trim();
    if (hdr.length() == 0) break;
    if (hdr.startsWith("Range:") || hdr.startsWith("range:")) {
      int eq = hdr.indexOf("bytes=");
      if (eq != -1) {
        String spec = hdr.substring(eq + 6);
        int dash = spec.indexOf('-');
        if (dash != -1) {
          hasRange = true;
          String sPart = spec.substring(0, dash);
          String ePart = spec.substring(dash + 1);
          sPart.trim();
          ePart.trim();
          rStart = strtoull(sPart.c_str(), nullptr, 10);
          if (ePart.length() > 0) {
            rEnd = strtoull(ePart.c_str(), nullptr, 10);
          }
        }
      }
    }
  }

  bool isHead = reqLine.startsWith("HEAD ");
  if (reqLine.indexOf("/manifest.json") != -1) {
    String body = "{\"ssid\":\"" + String(MAP_AP_SSID) +
                  "\",\"ip\":\"" + WiFi.softAPIP().toString() +
                  "\",\"path\":\"/maps/region.pmtiles\",\"sizeBytes\":" +
                  u64ToString(relayStats.mapFileSizeBytes) +
                  ",\"sdReady\":" + String(relayStats.sdReady ? "true" : "false") +
                  ",\"validPmTiles\":" + String(relayStats.mapValidHeader ? "true" : "false") + "}";
    client.println("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *");
    client.printf("Content-Length: %u\r\nConnection: close\r\n\r\n", (unsigned int)body.length());
    if (!isHead) client.print(body);
  } else if (reqLine.indexOf("/maps/region.pmtiles") != -1 || reqLine.indexOf("/region.pmtiles") != -1) {
    streamSdRangeResponse(client, isHead, hasRange, rStart, rEnd);
  } else {
    String okMsg = "ERVONET Map Hub Active. GET /manifest.json or /maps/region.pmtiles";
    client.println("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *");
    client.printf("Content-Length: %u\r\nConnection: close\r\n\r\n", (unsigned int)okMsg.length());
    if (!isHead) client.print(okMsg);
  }

  client.flush();
  client.stop();
}

#endif

