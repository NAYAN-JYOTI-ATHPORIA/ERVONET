#ifndef ERVONET_PROTOCOL_H
#define ERVONET_PROTOCOL_H

#include "config.h"
#include <mbedtls/md.h>

// ============================================================================
// TIMESTAMP & CONVERSION HELPERS
// ============================================================================
static inline uint64_t currentTimestampMs() {
  return (uint64_t)(epochOffsetMs + (int64_t)millis());
}

static inline String u64ToString(uint64_t val) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%llu", (unsigned long long)val);
  return String(buf);
}

static inline uint32_t fnv1aHash(const String& s) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < s.length(); i++) {
    h ^= (uint8_t)s[i];
    h *= 16777619u;
  }
  return h;
}

// ============================================================================
// ADLER-32 PACKET CHECKSUM (Exact parity with src/protocol/packetSchema.ts)
// ============================================================================
static String computeAdlerChecksum(const String& str) {
  uint32_t a = 1;
  uint32_t b = 0;
  const uint32_t MOD_ADLER = 65521;
  for (size_t i = 0; i < str.length(); i++) {
    a = (a + (uint8_t)str[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  uint32_t combined = ((b << 16) | a);
  char hexBuf[12];
  snprintf(hexBuf, sizeof(hexBuf), "%X", (unsigned int)combined);
  return String(hexBuf);
}

// ============================================================================
// HMAC-SHA256 AUTHENTICATION & SHA256-CTR PAYLOAD CRYPTO (Built-in mbedTLS)
// ============================================================================
static String computeHmacSha256Hex(const String& message, size_t hexChars = 16) {
  uint8_t hmac[32];
  const mbedtls_md_info_t* mdInfo = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!mdInfo) return "";

  const char* key = ERVONET_NETWORK_PSK;
  mbedtls_md_hmac(mdInfo, (const uint8_t*)key, strlen(key),
                  (const uint8_t*)message.c_str(), message.length(), hmac);

  String out = "";
  out.reserve(hexChars);
  size_t byteCount = (hexChars + 1) / 2;
  if (byteCount > 32) byteCount = 32;
  char tmp[3];
  for (size_t i = 0; i < byteCount; i++) {
    snprintf(tmp, sizeof(tmp), "%02X", hmac[i]);
    out += tmp;
  }
  if (out.length() > hexChars) out = out.substring(0, hexChars);
  return out;
}

static bool hexNibble(char c, uint8_t& val) {
  if (c >= '0' && c <= '9') { val = c - '0'; return true; }
  if (c >= 'A' && c <= 'F') { val = 10 + (c - 'A'); return true; }
  if (c >= 'a' && c <= 'f') { val = 10 + (c - 'a'); return true; }
  return false;
}

static String sha256CtrTransform(const String& inputBytes, const String& nonce) {
  const mbedtls_md_info_t* mdInfo = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!mdInfo) return inputBytes;

  String out = "";
  out.reserve(inputBytes.length());
  uint8_t keystream[32];
  uint32_t counter = 0;

  for (size_t offset = 0; offset < inputBytes.length(); offset += 32, counter++) {
    String blockInput = String(ERVONET_NETWORK_PSK) + "|" + nonce + "|" + String(counter);
    mbedtls_md(mdInfo, (const uint8_t*)blockInput.c_str(), blockInput.length(), keystream);
    size_t blockLen = min((size_t)32, inputBytes.length() - offset);
    for (size_t j = 0; j < blockLen; j++) {
      out += (char)((uint8_t)inputBytes[offset + j] ^ keystream[j]);
    }
  }
  return out;
}

static String encryptTextToHex(const String& plainText, const String& nonce) {
  String rawCipher = sha256CtrTransform(plainText, nonce);
  String hexOut = "";
  hexOut.reserve(rawCipher.length() * 2);
  char buf[3];
  for (size_t i = 0; i < rawCipher.length(); i++) {
    snprintf(buf, sizeof(buf), "%02X", (uint8_t)rawCipher[i]);
    hexOut += buf;
  }
  return hexOut;
}

static String decryptHexToText(const String& hexCipher, const String& nonce) {
  if (hexCipher.length() % 2 != 0) return hexCipher;
  String rawCipher = "";
  rawCipher.reserve(hexCipher.length() / 2);
  for (size_t i = 0; i < hexCipher.length(); i += 2) {
    uint8_t hi = 0, lo = 0;
    if (!hexNibble(hexCipher[i], hi) || !hexNibble(hexCipher[i + 1], lo)) {
      return hexCipher;
    }
    rawCipher += (char)((hi << 4) | lo);
  }
  return sha256CtrTransform(rawCipher, nonce);
}

// ============================================================================
// LIGHTWEIGHT JSON PACKET PARSERS & MUTATORS
// ============================================================================
static String extractJsonString(const String& json, const char* key) {
  String pattern = String("\"") + key + "\":\"";
  int idx = json.indexOf(pattern);
  if (idx == -1) return "";
  int start = idx + pattern.length();
  String out = "";
  for (int i = start; i < (int)json.length(); i++) {
    char c = json[i];
    if (c == '\\' && i + 1 < (int)json.length()) {
      out += c;
      out += json[++i];
      continue;
    }
    if (c == '"') break;
    out += c;
  }
  return out;
}

static String unescapeJsonString(const String& s) {
  String out = "";
  out.reserve(s.length());
  for (int i = 0; i < (int)s.length(); i++) {
    if (s[i] == '\\' && i + 1 < (int)s.length()) {
      char next = s[i + 1];
      if (next == '"' || next == '\\' || next == '/') { out += next; i++; continue; }
      if (next == 'n') { out += '\n'; i++; continue; }
      if (next == 'r') { out += '\r'; i++; continue; }
      if (next == 't') { out += '\t'; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

static long long extractJsonInt(const String& json, const char* key, long long defaultVal) {
  String pattern = String("\"") + key + "\":";
  int idx = json.indexOf(pattern);
  if (idx == -1) return defaultVal;
  int start = idx + pattern.length();
  while (start < (int)json.length() && (json[start] == ' ' || json[start] == '"')) start++;
  int end = start;
  while (end < (int)json.length() && ((json[end] >= '0' && json[end] <= '9') || json[end] == '-')) end++;
  if (end == start) return defaultVal;
  return atoll(json.substring(start, end).c_str());
}

static bool jsonArrayContains(const String& json, const char* arrayKey, const String& value) {
  String pattern = String("\"") + arrayKey + "\":[";
  int start = json.indexOf(pattern);
  if (start == -1) return false;
  int end = json.indexOf(']', start);
  if (end == -1) return false;
  String needle = String("\"") + value + "\"";
  String slice = json.substring(start, end + 1);
  return slice.indexOf(needle) != -1;
}

static String setOrUpdateJsonInt(String json, const char* key, long long newVal) {
  String pattern = String("\"") + key + "\":";
  int idx = json.indexOf(pattern);
  if (idx != -1) {
    int valStart = idx + pattern.length();
    while (valStart < (int)json.length() && json[valStart] == ' ') valStart++;
    int valEnd = valStart;
    while (valEnd < (int)json.length() && ((json[valEnd] >= '0' && json[valEnd] <= '9') || json[valEnd] == '-')) valEnd++;
    return json.substring(0, valStart) + String((long)newVal) + json.substring(valEnd);
  }
  int closeBrace = json.lastIndexOf('}');
  if (closeBrace != -1) {
    return json.substring(0, closeBrace) + ",\"" + key + "\":" + String((long)newVal) + "}";
  }
  return json;
}

static String appendToVisitedNodes(String json, const String& nodeId) {
  String pattern = "\"visitedNodes\":[";
  int start = json.indexOf(pattern);
  if (start != -1) {
    int end = json.indexOf(']', start);
    if (end != -1) {
      String inside = json.substring(start + pattern.length(), end);
      String entry = String("\"") + nodeId + "\"";
      if (inside.indexOf(entry) != -1) return json;
      String prefix = inside.length() > 0 ? "," : "";
      return json.substring(0, end) + prefix + entry + json.substring(end);
    }
  }
  int closeBrace = json.lastIndexOf('}');
  if (closeBrace != -1) {
    return json.substring(0, closeBrace) + ",\"visitedNodes\":[\"" + nodeId + "\"]}";
  }
  return json;
}

static uint8_t priorityRank(const String& priority) {
  if (priority == "CRITICAL_SOS" || priority == "SOS") return 3;
  if (priority == "URGENT" || priority == "IMPORTANT") return 2;
  return 1;
}

static bool validatePacketIntegrity(const String& rawJson, const String& msgId,
                                    const String& senderId, const String& destId,
                                    long long tsVal, const String& payloadRaw) {
  String pktChecksum = extractJsonString(rawJson, "checksum");
  if (pktChecksum.length() > 0 && pktChecksum != "SIMLSA") {
    String tsStr = u64ToString((uint64_t)tsVal);
    String unescaped = unescapeJsonString(payloadRaw);
    String expected = computeAdlerChecksum(msgId + "|" + senderId + "|" + destId + "|" + tsStr + "|" + unescaped);
    if (!expected.equalsIgnoreCase(pktChecksum)) {
      // Also check raw string fallback in case payload had no escapes
      String expectedRaw = computeAdlerChecksum(msgId + "|" + senderId + "|" + destId + "|" + tsStr + "|" + payloadRaw);
      if (!expectedRaw.equalsIgnoreCase(pktChecksum)) {
        Serial.printf("[VALIDATE] Checksum mismatch for %s: got=%s exp=%s\n",
                      msgId.c_str(), pktChecksum.c_str(), expected.c_str());
        return false;
      }
    }
  }

  String authTag = extractJsonString(rawJson, "authTag");
  if (ENFORCE_AUTH_TAG) {
    if (authTag.length() == 0) return false;
    String tsStr = u64ToString((uint64_t)tsVal);
    String expectedTag = computeHmacSha256Hex(msgId + "|" + senderId + "|" + destId + "|" + tsStr);
    if (!expectedTag.equalsIgnoreCase(authTag)) {
      Serial.printf("[SECURITY] Invalid HMAC authTag for %s\n", msgId.c_str());
      return false;
    }
  }
  return true;
}

// ============================================================================
// GENERIC MULTI-PART REASSEMBLY SLOTS (Shared by BLE & ESP-NOW)
// ============================================================================
struct ReassemblySlot {
  bool active;
  String key;
  uint8_t totalParts;
  uint32_t receivedMask;
  uint32_t createdMs;
  String parts[16];
};

static ReassemblySlot bleReassembly[MAX_REASSEMBLY_SLOTS];
static ReassemblySlot espReassembly[MAX_REASSEMBLY_SLOTS];

static String ingestPart(ReassemblySlot* slots, const String& key, uint8_t idx, uint8_t total, const String& slice) {
  if (total == 1 && idx == 0) return slice;
  if (total == 0 || total > 16 || idx >= total) return "";

  uint32_t now = millis();
  int freeSlot = -1;
  int targetSlot = -1;

  for (int i = 0; i < MAX_REASSEMBLY_SLOTS; i++) {
    if (slots[i].active && (now - slots[i].createdMs > 15000)) {
      slots[i].active = false;
    }
    if (slots[i].active && slots[i].key == key) {
      targetSlot = i;
      break;
    }
    if (!slots[i].active && freeSlot == -1) freeSlot = i;
  }

  if (targetSlot == -1) {
    targetSlot = (freeSlot != -1) ? freeSlot : 0;
    slots[targetSlot].active = true;
    slots[targetSlot].key = key;
    slots[targetSlot].totalParts = total;
    slots[targetSlot].receivedMask = 0;
    slots[targetSlot].createdMs = now;
    for (int j = 0; j < 16; j++) slots[targetSlot].parts[j] = "";
  }

  slots[targetSlot].parts[idx] = slice;
  slots[targetSlot].receivedMask |= (1UL << idx);

  uint32_t completeMask = (1UL << total) - 1UL;
  if ((slots[targetSlot].receivedMask & completeMask) == completeMask) {
    String assembled = "";
    for (uint8_t j = 0; j < total; j++) {
      assembled += slots[targetSlot].parts[j];
    }
    slots[targetSlot].active = false;
    return assembled;
  }
  return "";
}

#endif
