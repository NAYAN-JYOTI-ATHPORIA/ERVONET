package com.resqnet.ble

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

class BleAdvertiser(
    private val context: Context,
    private val bluetoothAdapter: BluetoothAdapter?,
    private val onMessageReceived: (senderAddress: String, payload: String) -> Unit,
    private val onClientConnected: (deviceAddress: String, deviceName: String) -> Unit,
    private val onClientDisconnected: (deviceAddress: String) -> Unit,
    private val onAdvStateChanged: (isAdvertising: Boolean, errorMsg: String?) -> Unit
) {
    private val TAG = "ResQNetAdvertiser"
    private var bluetoothLeAdvertiser: BluetoothLeAdvertiser? = null
    private var gattServer: BluetoothGattServer? = null
    private var isAdvertising = false
    private var localNodeId: String = "RESQ-NODE-01"
    private var localNodeRole: String = "Field Worker"

    private val connectedCentrals = mutableSetOf<BluetoothDevice>()
    private val subscribedCentrals = ConcurrentHashMap.newKeySet<String>()
    private val preparedBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()
    var nameLookup: ((String) -> String?)? = null

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            Log.d(TAG, "BLE Advertising started successfully")
            isAdvertising = true
            onAdvStateChanged(true, null)
        }

        override fun onStartFailure(errorCode: Int) {
            val errorMsg = when (errorCode) {
                ADVERTISE_FAILED_ALREADY_STARTED -> "Advertising already started"
                ADVERTISE_FAILED_DATA_TOO_LARGE -> "Advertise data too large"
                ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "Advertising feature unsupported"
                ADVERTISE_FAILED_INTERNAL_ERROR -> "Advertising internal error"
                ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "Too many advertisers running"
                else -> "Advertising failed with error code $errorCode"
            }
            Log.e(TAG, errorMsg)
            isAdvertising = false
            onAdvStateChanged(false, errorMsg)
        }
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            Log.d(TAG, "GATT Server connection state change: ${device.address}, status=$status, newState=$newState")
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connectedCentrals.add(device)
                val knownName = nameLookup?.invoke(device.address)
                val devName = knownName
                    ?: try { device.name?.takeIf { !it.startsWith("Android-") && !it.startsWith("Device") } } catch (e: Exception) { null }
                    ?: "User-${device.address.takeLast(4).replace(":", "")}"
                onClientConnected(device.address, devName)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connectedCentrals.remove(device)
                subscribedCentrals.remove(device.address)
                preparedBuffers.remove(device.address)
                onClientDisconnected(device.address)
            }
        }

        @SuppressLint("MissingPermission")
        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (characteristic.uuid == ResQNetConstants.CHAR_RX_MESSAGE_UUID) {
                if (preparedWrite) {
                    val buffer = preparedBuffers.getOrPut(device.address) { ByteArrayOutputStream() }
                    if (value != null) {
                        buffer.write(value)
                    }
                    if (responseNeeded) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                    }
                    return
                }

                val payload = value?.let { String(it, StandardCharsets.UTF_8) } ?: ""
                Log.d(TAG, "GATT Server received packet from ${device.address}: $payload")

                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }

                if (payload.isNotEmpty()) {
                    onMessageReceived(device.address, payload)
                }
            } else {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                }
            }
        }

        @SuppressLint("MissingPermission")
        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            Log.d(TAG, "GATT Server onExecuteWrite from ${device.address}, execute=$execute")
            val buffer = preparedBuffers.remove(device.address)
            if (execute && buffer != null) {
                val payload = buffer.toString(StandardCharsets.UTF_8.name())
                if (payload.isNotEmpty()) {
                    onMessageReceived(device.address, payload)
                }
            }
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
        }

        @SuppressLint("MissingPermission")
        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (characteristic.uuid == ResQNetConstants.CHAR_NODE_INFO_UUID) {
                val infoJson = """{"nodeId":"$localNodeId","role":"$localNodeRole","version":"${ResQNetConstants.PROTOCOL_VERSION}"}"""
                val data = infoJson.toByteArray(StandardCharsets.UTF_8)
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, data)
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
            }
        }

        @SuppressLint("MissingPermission")
        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (descriptor.uuid == ResQNetConstants.CCCD_UUID) {
                descriptor.value = value
                val isSubscribed = value != null && (
                    value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ||
                    value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
                )
                if (isSubscribed) {
                    subscribedCentrals.add(device.address)
                    Log.d(TAG, "Central ${device.address} subscribed to TX notifications")
                } else {
                    subscribedCentrals.remove(device.address)
                }
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            } else {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            }
        }
    }

    private fun getActiveAdapter(): BluetoothAdapter? {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return manager?.adapter ?: bluetoothAdapter ?: BluetoothAdapter.getDefaultAdapter()
    }

    @SuppressLint("MissingPermission")
    fun start(nodeId: String, nodeRole: String, displayName: String? = null): Boolean {
        val adapter = getActiveAdapter()
        if (adapter == null || !adapter.isEnabled) {
            Log.e(TAG, "Bluetooth not available or enabled")
            return false
        }

        localNodeId = nodeId
        localNodeRole = nodeRole

        // Attempt to update adapter's local name for seamless peer discovery
        val friendlyName = displayName ?: nodeId
        try {
            adapter.name = friendlyName.take(24)
        } catch (e: Exception) {
            Log.w(TAG, "Could not set adapter name: ${e.message}")
        }

        val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        if (bluetoothManager == null) {
            Log.e(TAG, "BluetoothManager not found")
            return false
        }

        // Setup GATT Server
        if (gattServer == null) {
            gattServer = bluetoothManager.openGattServer(context, gattServerCallback)
            if (gattServer == null) {
                Log.e(TAG, "Failed to open GATT Server")
                return false
            }

            val service = BluetoothGattService(
                ResQNetConstants.SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY
            )

            // RX Characteristic (Clients write to this)
            val rxChar = BluetoothGattCharacteristic(
                ResQNetConstants.CHAR_RX_MESSAGE_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            )

            // TX Characteristic (Server notifies clients)
            val txChar = BluetoothGattCharacteristic(
                ResQNetConstants.CHAR_TX_MESSAGE_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE,
                BluetoothGattCharacteristic.PERMISSION_READ
            )
            val cccd = BluetoothGattDescriptor(
                ResQNetConstants.CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_WRITE or BluetoothGattDescriptor.PERMISSION_READ
            )
            txChar.addDescriptor(cccd)

            // Node Info Characteristic (Read only)
            val infoChar = BluetoothGattCharacteristic(
                ResQNetConstants.CHAR_NODE_INFO_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ
            )

            service.addCharacteristic(rxChar)
            service.addCharacteristic(txChar)
            service.addCharacteristic(infoChar)

            val added = gattServer?.addService(service) ?: false
            Log.d(TAG, "GATT Service added: $added")
        }

        // Setup BLE Advertising
        bluetoothLeAdvertiser = adapter.bluetoothLeAdvertiser
        if (bluetoothLeAdvertiser == null) {
            Log.e(TAG, "BluetoothLeAdvertiser not supported on this device")
            return false
        }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build()

        val serviceUuid = ParcelUuid(ResQNetConstants.SERVICE_UUID)
        val dataBuilder = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceUuid(serviceUuid)

        val fixedId = if (nodeId.startsWith("ERVO-")) nodeId.removePrefix("ERVO-").take(4)
            else if (nodeId.startsWith("RESQ-")) nodeId.removePrefix("RESQ-").take(4)
            else nodeId.take(4)
        val humanName = displayName?.takeIf { it.isNotBlank() } ?: nodeId
        // Format: "E:XXXX:Name" - embeds ERVONET fixed device ID and human username safely within BLE 24-byte limit
        val advSignature = "E:$fixedId:${humanName.take(14)}"
        val nodeBytes = advSignature.toByteArray(StandardCharsets.UTF_8)

        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(ResQNetConstants.MANUFACTURER_ID, nodeBytes)
            .build()

        try {
            bluetoothLeAdvertiser?.startAdvertising(settings, dataBuilder.build(), scanResponse, advertiseCallback)
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Exception starting advertising: ${e.message}")
            return false
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        try {
            getActiveAdapter()?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping advertising: ${e.message}")
        }
        isAdvertising = false

        try {
            gattServer?.close()
            gattServer = null
        } catch (e: Exception) {
            Log.e(TAG, "Error closing GATT server: ${e.message}")
        }
        connectedCentrals.clear()
        subscribedCentrals.clear()
        preparedBuffers.clear()
        onAdvStateChanged(false, null)
    }

    @SuppressLint("MissingPermission")
    fun sendMessageToCentral(targetAddress: String, payload: String): Boolean {
        val server = gattServer ?: return false
        val service = server.getService(ResQNetConstants.SERVICE_UUID) ?: return false
        val txChar = service.getCharacteristic(ResQNetConstants.CHAR_TX_MESSAGE_UUID) ?: return false

        val bytes = payload.toByteArray(StandardCharsets.UTF_8)
        val targetDevice = connectedCentrals.find { it.address.equals(targetAddress, ignoreCase = true) } ?: return false

        return try {
            val success = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val status = server.notifyCharacteristicChanged(targetDevice, txChar, false, bytes)
                status == BluetoothStatusCodes.SUCCESS
            } else {
                txChar.value = bytes
                server.notifyCharacteristicChanged(targetDevice, txChar, false)
            }
            if (success) {
                Log.d(TAG, "GATT Server notified Central $targetAddress (${bytes.size} bytes)")
            } else {
                Log.w(TAG, "GATT Server notify returned false for Central $targetAddress")
            }
            success
        } catch (e: Exception) {
            Log.e(TAG, "Failed to notify central $targetAddress: ${e.message}")
            false
        }
    }

    @SuppressLint("MissingPermission")
    fun notifyCentrals(messageJson: String): Int {
        val server = gattServer ?: return 0
        val service = server.getService(ResQNetConstants.SERVICE_UUID) ?: return 0
        val txChar = service.getCharacteristic(ResQNetConstants.CHAR_TX_MESSAGE_UUID) ?: return 0

        val bytes = messageJson.toByteArray(StandardCharsets.UTF_8)
        var count = 0

        for (device in connectedCentrals) {
            try {
                val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val status = server.notifyCharacteristicChanged(device, txChar, false, bytes)
                    status == BluetoothStatusCodes.SUCCESS
                } else {
                    txChar.value = bytes
                    server.notifyCharacteristicChanged(device, txChar, false)
                }
                if (ok) count++
            } catch (e: Exception) {
                Log.w(TAG, "Notify failed for ${device.address}: ${e.message}")
            }
        }
        return count
    }

    fun isCentralConnected(targetAddress: String): Boolean {
        return connectedCentrals.any { it.address.equals(targetAddress, ignoreCase = true) }
    }

    fun isCentralSubscribed(targetAddress: String): Boolean {
        return subscribedCentrals.any { it.equals(targetAddress, ignoreCase = true) }
    }

    fun isCurrentlyAdvertising(): Boolean = isAdvertising
    fun getConnectedCentralCount(): Int = connectedCentrals.size
}
