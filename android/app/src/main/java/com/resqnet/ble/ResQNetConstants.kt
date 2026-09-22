package com.resqnet.ble

import java.util.UUID

object ResQNetConstants {
    // Official ResQNet Service UUID (128-bit)
    val SERVICE_UUID: UUID = UUID.fromString("0000FE20-0000-1000-8000-00805F9B34FB")

    // RX Characteristic: Used by remote Centrals to WRITE messages to this node
    val CHAR_RX_MESSAGE_UUID: UUID = UUID.fromString("0000FE21-0000-1000-8000-00805F9B34FB")

    // TX Characteristic: Used by this GATT Server to NOTIFY/INDICATE messages to connected Centrals
    val CHAR_TX_MESSAGE_UUID: UUID = UUID.fromString("0000FE22-0000-1000-8000-00805F9B34FB")

    // Node Info Characteristic: Read-only characteristic for Node ID, Role, and Protocol Version
    val CHAR_NODE_INFO_UUID: UUID = UUID.fromString("0000FE23-0000-1000-8000-00805F9B34FB")

    // Client Characteristic Configuration Descriptor (CCCD) for enabling notifications
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")

    const val PROTOCOL_VERSION = "1.0"
    const val DEFAULT_TTL = 3
    const val MANUFACTURER_ID = 0x05F9 // Custom manufacturer ID for ResQNet framing

    // Events dispatched to React Native
    const val EVENT_NODE_DISCOVERED = "onNodeDiscovered"
    const val EVENT_NODE_CONNECTED = "onNodeConnected"
    const val EVENT_NODE_DISCONNECTED = "onNodeDisconnected"
    const val EVENT_MESSAGE_RECEIVED = "onMessageReceived"
    const val EVENT_MESSAGE_DELIVERED = "onMessageDelivered"
    const val EVENT_SCAN_STATUS_CHANGED = "onScanStatusChanged"
    const val EVENT_ADV_STATUS_CHANGED = "onAdvertisingStatusChanged"
    const val EVENT_RADIO_STATE_CHANGED = "onRadioStateChanged"
}

