#ifndef ERVONET_CONFIG_H
#define ERVONET_CONFIG_H

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// ============================================================================
// NODE IDENTITY & 2.4 GHz COEXISTENCE RADIO CONFIGURATION
// ============================================================================
// Leave empty "" to auto-derive unique 4-char ID (e.g. "ES9A") from ESP32 eFuse MAC,
// OR assign explicit 4-char IDs on test hardware such as "ESP1" and "ESP2".
#define CUSTOM_NODE_SUFFIX       ""
#define WIFI_MESH_CHANNEL        1       // Fixed Ch 1 shared across ESP-NOW + SoftAP

// ============================================================================
// HARDWARE PINS (Target: ESP32 Dev Module / ESP32-WROOM-32)
// ============================================================================
#define LED_STATUS_PIN           2       // Onboard blue LED on ESP32 DevKit v1
#define SOS_BUTTON_PIN           4       // Momentary pushbutton -> GND (Short=SOS, Long=Map AP)
#define BUZZER_PIN               15      // Optional 3.3V piezo buzzer (+ to GPIO 15, - to GND)
#define BATTERY_ADC_PIN          34      // ADC1 input for 2:1 LiPo voltage divider (Wi-Fi safe)
#define ENABLE_BATTERY_MONITOR   false   // Set true only if GPIO 34 divider is attached

// SPI MicroSD Card Module (Hardware VSPI)
#define SD_CS_PIN                5
#define SD_SCK_PIN               18
#define SD_MISO_PIN              19
#define SD_MOSI_PIN              23

// ============================================================================
// ON-DEMAND OFFLINE MAP SERVER & PERSISTENCE SETTINGS
// ============================================================================
#define MAP_AP_SSID              "ERVONET-MAP-HUB"
#define MAP_AP_PASS              "ervonet2026"
#define MAP_PMTILES_PATH         "/maps/region.pmtiles"
#define MAP_AP_IDLE_TIMEOUT_MS   300000UL  // Auto-shutdown SoftAP after 5 minutes idle
#define MAP_LONG_PRESS_MS        2500      // Hold GPIO 4 >= 2.5s to toggle Map Hub SoftAP
#define PERSISTENT_SOS_PATH      "/sos_queue.txt"
#define ENABLE_PERSISTENT_SOS    true

// ============================================================================
// EXISTING ERVONET BLE GATT CONSTANTS (Must match ResQNetConstants.kt)
// ============================================================================
#define SERVICE_UUID             "0000FE20-0000-1000-8000-00805F9B34FB"
#define CHAR_RX_MESSAGE_UUID     "0000FE21-0000-1000-8000-00805F9B34FB"
#define CHAR_TX_MESSAGE_UUID     "0000FE22-0000-1000-8000-00805F9B34FB"
#define CHAR_NODE_INFO_UUID      "0000FE23-0000-1000-8000-00805F9B34FB"
#define MANUFACTURER_ID_LO       0xF9
#define MANUFACTURER_ID_HI       0x05

// ============================================================================
// CAPACITY, TIMING & STORE-AND-FORWARD POLICIES
// ============================================================================
#define MAX_PACKET_JSON_LEN      2048
#define ESPNOW_CHUNK_BYTES       196
#define SEEN_MSG_CACHE_SIZE      64
#define MAX_BLE_PHONES           6
#define MAX_ESPNOW_NEIGHBORS     12
#define MAX_REASSEMBLY_SLOTS     8
#define OUTBOX_MAX_SLOTS         24
#define OUTBOX_MAX_RETRIES       8

#define BEACON_INTERVAL_MS       3500
#define LSA_INTERVAL_MS          5000
#define STATUS_INTERVAL_MS       10000
#define OUTBOX_FLUSH_INTERVAL_MS 1200
#define OUTBOX_NORMAL_TTL_MS     1800000UL  // 30 minutes
#define OUTBOX_SOS_TTL_MS        7200000UL  // 2 hours for CRITICAL_SOS retention
#define NODE_STALE_MS            45000UL

// ============================================================================
// APPLICATION-LAYER SECURITY (Pre-Shared Tactical Network Key)
// ============================================================================
// Keep plaintext defaults for initial Phase 1-4 bring-up, then toggle to true
// once BLE + ESP-NOW relay path is verified cleanly on both boards.
#define ENABLE_APP_ENCRYPTION    false
#define ENFORCE_AUTH_TAG         false
#define ERVONET_NETWORK_PSK      "ERVONET-TACTICAL-MESH-KEY-2026!"

// ============================================================================
// SHARED SYNCHRONIZATION, LED MODES & TELEMETRY COUNTERS
// ============================================================================
enum RelayLedMode {
  LED_MODE_IDLE = 0,
  LED_MODE_BLE_CONNECTED = 1,
  LED_MODE_ESPNOW_ACTIVE = 2,
  LED_MODE_MAP_SERVER = 3,
  LED_MODE_SOS_ALERT = 4
};

struct RelayStats {
  uint32_t rxBlePackets = 0;
  uint32_t rxEspNowPackets = 0;
  uint32_t relayedPackets = 0;
  uint32_t deliveredLocalBle = 0;
  uint32_t droppedInvalid = 0;
  uint32_t droppedDuplicate = 0;
  uint32_t outboxEvicted = 0;
  bool sdReady = false;
  bool littleFsReady = false;
  bool mapServerActive = false;
  uint64_t mapFileSizeBytes = 0;
  bool mapValidHeader = false;
};

static String myNodeId = "";
static String myNodeName = "";
static int64_t epochOffsetMs = 1793860000000LL;
static RelayStats relayStats;

static SemaphoreHandle_t stateMutex = nullptr;
static SemaphoreHandle_t bleTxMutex = nullptr;
static SemaphoreHandle_t espTxMutex = nullptr;

static inline bool takeStateLock(uint32_t timeoutMs = 200) {
  if (stateMutex == nullptr) return true;
  return xSemaphoreTake(stateMutex, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

static inline void giveStateLock() {
  if (stateMutex != nullptr) {
    xSemaphoreGive(stateMutex);
  }
}

#endif
