# ERVONET Hybrid BLE + ESP-NOW Intermediate Relay Firmware

This module turns any standard **ESP32** (`ESP32 Dev Module` / `ESP32-WROOM-32`) into an autonomous, 100% offline **Hybrid BLE + Wi-Fi (ESP-NOW)** intermediate relay node for **ERVONET**:

- **Mobile ↔ ESP32 (BLE GATT Server):** Uses ERVONET's exact Service UUID (`0000FE20-0000-1000-8000-00805F9B34FB`), RX/TX/Info Characteristics (`0xFE21`/`0xFE22`/`0xFE23`), Manufacturer Data (`0x05F9`, `"E:<ID>:<Name>"`), and `RESQ_CHUNK:` framing (`180B` slices) for seamless discovery and reconnection with Android mobile devices.
- **ESP32 ↔ ESP32 (ESP-NOW Multi-Hop Mesh):** Uses connectionless IEEE 802.11 ESP-NOW on fixed Wi-Fi Channel `1` (`WIFI_PS_NONE`), automatically fragmenting packets to fit the `250B` ESP-NOW frame limit, propagating LSAs and `NODE_STATUS` telemetry, suppressing duplicates (`64`-slot ring buffer) and loops (`visitedNodes` + `ttl`), and buffering undelivered packets in a **24-slot Store-and-Forward priority queue**.

---

## Modular Folder Structure

```text
esp32-relay-firmware/
├── ervonet_esp32_relay/
│   ├── ervonet_esp32_relay.ino  # FreeRTOS Core 0/1 setup, hybrid router, SOS/Map button & loop
│   ├── config.h                 # Node ID, pins (LED/SOS/Buzzer/ADC/SD SPI), UUIDs, mutexes, PSK
│   ├── protocol.h               # Adler-32 checksum, HMAC-SHA256, SHA256-CTR, JSON & ReassemblySlot
│   ├── routing_table.h          # BLE phone table, ESP-NOW neighbors (with RSSI), LSA & NODE_STATUS
│   ├── comm_espnow.h            # Wi-Fi Ch.1 STA setup, Core 2.x/3.x ISR queue, mutex 250B TX/RX
│   ├── comm_ble.h               # BLE GATT Server (0xFE20..0xFE23), mutex RESQ_CHUNK framing & queue
│   ├── store_forward.h          # 24-slot priority queue + internal LittleFS CRITICAL_SOS backup
│   └── map_server.h             # On-demand SoftAP ERVONET-MAP-HUB + HTTP 206 MicroSD range server
├── expo-adapter/
│   └── ErvonetExpoBleAdapter.ts # Standalone Expo Dev Client (react-native-ble-plx) reference module
└── README.md
```

---

## Hardware Connections (Per ESP32 Board)

| Component | ESP32 Pin | Wiring / Notes |
|---|---|---|
| **Status LED** | `GPIO 2` (onboard LED) or `GPIO 2 -> 220Ω -> LED(+) -> GND` | Non-blocking pattern: Idle flash (3s), BLE Connected (1.2s), ESP-NOW (1.8s), Map AP (rapid blink), SOS (strobe) |
| **SOS & Map Hub Button** | `GPIO 4 <-> Momentary Pushbutton <-> GND` | **Short press (`< 2.5s`)**: Broadcasts `CRITICAL_SOS` • **Long press (`>= 2.5s`)**: Toggles Wi-Fi SoftAP Map Server |
| **Optional Buzzer** | `GPIO 15 (+) -> Active 3.3V Buzzer -> GND (-)` | Pulses briefly on boot, SOS alert, and Map Server toggle (`BUZZER_PIN -1` disables) |
| **Optional Battery ADC** | `GPIO 34 <- 100kΩ/100kΩ Voltage Divider <- LiPo VBAT` | Safe ADC1 pin during Wi-Fi active (`#define ENABLE_BATTERY_MONITOR true` in `config.h`) |
| **SPI MicroSD Card** | `CS=5`, `SCK=18`, `MISO=19`, `MOSI=23`, `VCC=3.3V/5V` | Stores `/maps/region.pmtiles` for on-demand HTTP `206 Partial Content` streaming (`ERVONET-MAP-HUB`) |
| **Offline Power** | `USB 5V` / Power Bank / `LiPo` + `AMS1117 3.3V` | Completely independent of mains power, cellular towers, and Wi-Fi routers |

---

## Flashing Instructions & Partition Scheme Fix (Arduino IDE)

1. Install Arduino IDE `2.x` and Board Package **`esp32 by Espressif Systems`** (both Core `2.x` and `3.x` are supported cleanly).
2. Open [`ervonet_esp32_relay.ino`](ervonet_esp32_relay/ervonet_esp32_relay.ino) in Arduino IDE (all 6 `.h` modules in the same folder load automatically as editor tabs).
3. Select **Tools -> Board -> ESP32 Arduino -> `ESP32 Dev Module`**.
4. **CRITICAL — Set Partition Scheme (Fixes `Sketch uses ~126%` Flash Overflow):**
   Because ESP32 Wi-Fi + ESP-NOW + built-in Bluedroid BLE firmware binaries combine to ~`1.66 MB` (`> 1.31 MB` default partition):
   - Go to **Tools -> Partition Scheme**
   - Select **`Huge APP (3MB No OTA/1MB SPIFFS)`** *(gives `3,145,728` bytes app space)* **OR** **`Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)`** *(gives `1,966,080` bytes)*.
5. *(Optional Lab IDs)* In [`config.h`](ervonet_esp32_relay/config.h):
   - Board 1: `#define CUSTOM_NODE_SUFFIX "ESP1"` (`ERVO-ESP1` / `ESP32-Relay-P1`)
   - Board 2: `#define CUSTOM_NODE_SUFFIX "ESP2"` (`ERVO-ESP2` / `ESP32-Relay-P2`)
   - Or keep `""` to derive a unique ID from each chip's eFuse MAC.
6. Ensure `#define WIFI_MESH_CHANNEL 1` is identical across every ESP32 relay.
7. Click **Upload**, then open **Tools -> Serial Monitor** at `115200` baud.

### Serial Monitor Debug Console Commands

Send these uppercase commands (with Newline) in Arduino Serial Monitor at `115200` baud:
- `STATUS` — Prints node ID, channel, MAC, active BLE clients, ESP-NOW peer count, RX/TX/relay counters, outbox depth, battery %, free heap.
- `PEERS` — Lists connected BLE phones and live ESP-NOW neighbor relays with RSSI (`dBm`).
- `OUTBOX` — Lists every message currently buffered in Store-and-Forward awaiting delivery or ACK.
- `SOS` — Simulates a physical GPIO 4 hardware SOS emergency broadcast over BLE & ESP-NOW.

---

## Security Modes (`config.h`)

- **Phase 1–4 Bring-up Defaults:** `ENABLE_APP_ENCRYPTION false`, `ENFORCE_AUTH_TAG false`. Packets include `checksum` (Adler-32) and `authTag` (16-hex HMAC-SHA256) with readable payloads for easy Serial inspection.
- **Tactical Production Security:** Set identical `ERVONET_NETWORK_PSK` across all ESP32s and RN app builds (`src/protocol/security.ts`), then enable `ENABLE_APP_ENCRYPTION true` / `ENFORCE_AUTH_TAG true` in [`config.h`](ervonet_esp32_relay/config.h) to enforce HMAC-SHA256 verification and SHA256-CTR payload encryption across relays.

---

## Phased 2-Phone + 2-ESP32 Test Plan (100% Offline)

1. **Phase 1 (Mobile A <-> ESP32-1 BLE):** Flash & power **ESP32-1**. Launch ERVONET on **Phone A** (airplane mode/no internet, BT + Location ON). `ESP32-Relay-P1` (`ERVO-ESP1`) shows an `[IOT RELAY]` badge and auto-connects.
2. **Phase 2 (ESP32-1 <-> ESP32-2 ESP-NOW):** Power **ESP32-2**. Within `3–4s`, both Serial Monitors print `[ESP-NOW] Discovered relay peer: ...`.
3. **Phase 3 (End-to-End Relay `Phone A -> ESP32-1 -> ESP32-2 -> Phone B`):**
   - Keep **Phone A** next to **ESP32-1**, **Phone B** next to **ESP32-2**, with Phone A & Phone B separated outside direct phone BLE range while ESP32 boards stay within ESP-NOW range (`20–80m+` indoors/line-of-sight).
   - Send a direct message, Broadcast, or `CRITICAL_SOS` from Phone A to Phone B.
   - Verify `[RELAY #...]` logs on ESP32-1 & ESP32-2, `[DIJKSTRA MESH ROUTE]` trace on Phone B, and return `ACKNOWLEDGED` receipt on Phone A.
4. **Phase 4 (Store-and-Forward Reconnection Test):**
   - Temporarily close Bluetooth on **Phone B** (`Phone A` -> `ESP32-1` -> `ESP32-2`). Notice ESP32-2 Serial prints `[OUTBOX] Queued ...`.
   - Re-enable Bluetooth on **Phone B**. As soon as `HANDSHAKE:` arrives, ESP32-2 prints `[OUTBOX] Delivered stored packet ...` and Phone B receives the buffered message.
5. **Phase 5 (Hardware SOS Button):** Short `GPIO 4` to `GND` (or type `SOS` in Serial Monitor) on ESP32-1 and confirm both Phone A and Phone B receive `[CRITICAL SOS]`.
