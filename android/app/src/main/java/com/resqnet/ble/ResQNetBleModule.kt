package com.resqnet.ble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class ResQNetBleModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val TAG = "ResQNetBleModule"

    private val bluetoothManager: BluetoothManager? by lazy {
        reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    }

    private val bluetoothAdapter: BluetoothAdapter?
        get() = bluetoothManager?.adapter ?: BluetoothAdapter.getDefaultAdapter()

    private var bleAdvertiser: BleAdvertiser? = null
    private var bleScanner: BleScanner? = null

    init {
        initializeBle()
    }

    override fun getName(): String = "ResQNetBle"

    private fun initializeBle() {
        bleAdvertiser = BleAdvertiser(
            context = reactContext,
            bluetoothAdapter = bluetoothAdapter,
            onMessageReceived = { senderAddress, payload ->
                val params = Arguments.createMap().apply {
                    putString("senderAddress", senderAddress)
                    putString("payload", payload)
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_MESSAGE_RECEIVED, params)
            },
            onClientConnected = { deviceAddress, deviceName ->
                val params = Arguments.createMap().apply {
                    putString("address", deviceAddress)
                    putString("nodeId", deviceName)
                    putString("name", deviceName)
                    putString("role", "CENTRAL")
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_NODE_CONNECTED, params)
            },
            onClientDisconnected = { deviceAddress ->
                val params = Arguments.createMap().apply {
                    putString("address", deviceAddress)
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_NODE_DISCONNECTED, params)
            },
            onAdvStateChanged = { isAdvertising, errorMsg ->
                val params = Arguments.createMap().apply {
                    putBoolean("isAdvertising", isAdvertising)
                    if (errorMsg != null) putString("error", errorMsg)
                }
                sendEvent(ResQNetConstants.EVENT_ADV_STATUS_CHANGED, params)
            }
        )

        bleScanner = BleScanner(
            context = reactContext,
            bluetoothAdapter = bluetoothAdapter,
            onNodeDiscovered = { address, name, nodeId, rssi, txPower ->
                val params = Arguments.createMap().apply {
                    putString("id", address)
                    putString("name", name)
                    putString("nodeId", nodeId)
                    putInt("rssi", rssi)
                    putInt("txPower", txPower)
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_NODE_DISCOVERED, params)
            },
            onNodeConnected = { address, nodeId, name ->
                val params = Arguments.createMap().apply {
                    putString("address", address)
                    putString("nodeId", nodeId)
                    putString("name", name)
                    putString("role", "PERIPHERAL")
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_NODE_CONNECTED, params)
            },
            onNodeDisconnected = { address ->
                val params = Arguments.createMap().apply {
                    putString("address", address)
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_NODE_DISCONNECTED, params)
            },
            onMessageReceived = { senderAddress, payload ->
                val params = Arguments.createMap().apply {
                    putString("senderAddress", senderAddress)
                    putString("payload", payload)
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_MESSAGE_RECEIVED, params)
            },
            onScanStateChanged = { isScanning ->
                val params = Arguments.createMap().apply {
                    putBoolean("isScanning", isScanning)
                }
                sendEvent(ResQNetConstants.EVENT_SCAN_STATUS_CHANGED, params)
            }
        )

        // Link scanner's discovered node names to advertiser for immediate Central name resolution
        bleAdvertiser?.nameLookup = { addr ->
            bleScanner?.getDiscoveredNodeName(addr)
        }

        // Link advertiser's connected centrals to scanner to prevent redundant cross-connections
        bleScanner?.isCentralConnectedLookup = { addr ->
            bleAdvertiser?.isCentralConnected(addr) == true
        }
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        if (reactContext.hasActiveReactInstance()) {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }

    private fun getOrCreateFixedDeviceId(): String {
        val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
        var deviceId = prefs.getString("FIXED_DEVICE_ID", null)
        if (deviceId.isNullOrEmpty()) {
            val legacyPrefs = reactContext.getSharedPreferences("ResQNetPrefs", Context.MODE_PRIVATE)
            val legacyId = legacyPrefs.getString("FIXED_DEVICE_ID", null)
            val suffix = if (!legacyId.isNullOrEmpty() && legacyId.length >= 4) {
                legacyId.takeLast(4).uppercase()
            } else {
                val androidId = try {
                    android.provider.Settings.Secure.getString(
                        reactContext.contentResolver,
                        android.provider.Settings.Secure.ANDROID_ID
                    )
                } catch (e: Exception) { null }

                if (!androidId.isNullOrEmpty() && androidId.length >= 4) {
                    androidId.takeLast(4).uppercase()
                } else {
                    java.util.UUID.randomUUID().toString().replace("-", "").take(4).uppercase()
                }
            }
            deviceId = "ERVO-$suffix"
            prefs.edit().putString("FIXED_DEVICE_ID", deviceId).apply()
        }
        return deviceId
    }

    @ReactMethod
    fun getFixedDeviceId(promise: Promise) {
        try {
            promise.resolve(getOrCreateFixedDeviceId())
        } catch (e: Exception) {
            promise.reject("DEVICE_ID_ERR", e.message)
        }
    }

    @ReactMethod
    fun getSavedUsername(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
            val username = prefs.getString("SAVED_USERNAME", "") ?: ""
            promise.resolve(username)
        } catch (e: Exception) {
            promise.reject("PREFS_ERR", e.message)
        }
    }

    @ReactMethod
    fun saveUsername(username: String, promise: Promise) {
        try {
            val clean = username.trim()
            val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
            prefs.edit().putString("SAVED_USERNAME", clean).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("PREFS_ERR", e.message)
        }
    }

    @ReactMethod
    fun getBluetoothStatus(promise: Promise) {
        val adapter = bluetoothAdapter
        val isSupported = adapter != null
        val isEnabled = adapter?.isEnabled ?: false
        val hasPermissions = checkBlePermissions()
        val fixedDeviceId = getOrCreateFixedDeviceId()
        val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
        val savedUsername = prefs.getString("SAVED_USERNAME", "") ?: ""

        val result = Arguments.createMap().apply {
            putBoolean("isSupported", isSupported)
            putBoolean("isEnabled", isEnabled)
            putBoolean("hasPermissions", hasPermissions)
            putBoolean("isAdvertising", bleAdvertiser?.isCurrentlyAdvertising() ?: false)
            putBoolean("isScanning", bleScanner?.isCurrentlyScanning() ?: false)
            putString("fixedDeviceId", fixedDeviceId)
            putString("savedUsername", savedUsername)
        }
        promise.resolve(result)
    }

    private fun updateForegroundService() {
        val isAdv = bleAdvertiser?.isCurrentlyAdvertising() ?: false
        val isScan = bleScanner?.isCurrentlyScanning() ?: false
        if (isAdv || isScan) {
            val count = (bleAdvertiser?.getConnectedCentralCount() ?: 0) + (bleScanner?.getConnectedNodes()?.size ?: 0)
            val text = if (count > 0) "Mesh Active • $count peer(s) connected offline" else "Mesh Active • Scanning & advertising for nearby nodes"
            ResQNetForegroundService.startService(reactContext, text)
        } else {
            ResQNetForegroundService.stopService(reactContext)
        }
    }

    @ReactMethod
    fun startAdvertising(nodeId: String, nodeRole: String, displayName: String?, promise: Promise) {
        if (!checkBlePermissions()) {
            promise.reject("PERMISSION_DENIED", "Bluetooth permissions not granted")
            return
        }

        val fixedId = getOrCreateFixedDeviceId()
        val actualNodeId = if (nodeId.startsWith("ERVO-") || nodeId.startsWith("RESQ-")) nodeId else fixedId
        val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
        val savedUsername = prefs.getString("SAVED_USERNAME", null)
        val actualDisplayName = displayName?.takeIf { it.isNotBlank() } ?: savedUsername
        val success = bleAdvertiser?.start(actualNodeId, nodeRole, actualDisplayName) ?: false
        if (success) {
            updateForegroundService()
            promise.resolve(true)
        } else {
            promise.reject("ADV_FAILED", "Failed to start BLE advertising")
        }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        bleAdvertiser?.stop()
        updateForegroundService()
        promise.resolve(true)
    }

    @ReactMethod
    fun startScanning(autoConnect: Boolean, promise: Promise) {
        if (!checkBlePermissions()) {
            promise.reject("PERMISSION_DENIED", "Bluetooth permissions not granted")
            return
        }

        val success = bleScanner?.startScan(autoConnect = autoConnect) ?: false
        if (success) {
            updateForegroundService()
            promise.resolve(true)
        } else {
            promise.reject("SCAN_FAILED", "Failed to start BLE scanner")
        }
    }

    @ReactMethod
    fun stopScanning(promise: Promise) {
        bleScanner?.stopScan()
        updateForegroundService()
        promise.resolve(true)
    }

    @ReactMethod
    fun startMeshService(statusText: String, promise: Promise) {
        try {
            ResQNetForegroundService.startService(reactContext, statusText)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("FG_SERVICE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun stopMeshService(promise: Promise) {
        try {
            ResQNetForegroundService.stopService(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("FG_SERVICE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun connect(deviceAddress: String, promise: Promise) {
        if (!checkBlePermissions()) {
            promise.reject("PERMISSION_DENIED", "Bluetooth permissions not granted")
            return
        }

        val started = bleScanner?.connect(deviceAddress) ?: false
        if (started) {
            promise.resolve(true)
        } else {
            promise.reject("CONNECT_FAILED", "Could not start connection to $deviceAddress")
        }
    }

    @ReactMethod
    fun disconnect(deviceAddress: String, promise: Promise) {
        bleScanner?.disconnect(deviceAddress)
        promise.resolve(true)
    }

    @ReactMethod
    fun sendMessage(targetAddress: String, packetJson: String, promise: Promise) {
        val startTime = System.currentTimeMillis()

        // 1. If connected as GATT Client (we write to peripheral's RX characteristic)
        if (bleScanner?.isConnected(targetAddress) == true) {
            bleScanner?.sendMessage(targetAddress, packetJson) { success, error ->
                val latency = System.currentTimeMillis() - startTime
                if (success) {
                    val params = Arguments.createMap().apply {
                        putString("targetAddress", targetAddress)
                        putDouble("latencyMs", latency.toDouble())
                        putDouble("timestamp", System.currentTimeMillis().toDouble())
                    }
                    sendEvent(ResQNetConstants.EVENT_MESSAGE_DELIVERED, params)
                    promise.resolve(true)
                } else {
                    promise.reject("SEND_FAILED", error ?: "Failed to write packet to $targetAddress")
                }
            }
            return
        }

        // 2. If connected as GATT Server (target is Central subscribed to our TX characteristic)
        if (bleAdvertiser?.isCentralConnected(targetAddress) == true) {
            val success = bleAdvertiser?.sendMessageToCentral(targetAddress, packetJson) ?: false
            val latency = System.currentTimeMillis() - startTime
            if (success) {
                val params = Arguments.createMap().apply {
                    putString("targetAddress", targetAddress)
                    putDouble("latencyMs", latency.toDouble())
                    putDouble("timestamp", System.currentTimeMillis().toDouble())
                }
                sendEvent(ResQNetConstants.EVENT_MESSAGE_DELIVERED, params)
                promise.resolve(true)
            } else {
                promise.reject("SEND_FAILED", "Failed to notify central $targetAddress")
            }
            return
        }

        promise.reject("NOT_CONNECTED", "Peer $targetAddress is not currently connected as client or central")
    }

    @ReactMethod
    fun broadcastMessage(packetJson: String, promise: Promise) {
        // Broadcast via both Central writes to connected peripherals AND GATT Server notifications to Centrals
        val centralsNotified = bleAdvertiser?.notifyCentrals(packetJson) ?: 0
        val centralTotal = bleAdvertiser?.getConnectedCentralCount() ?: 0

        bleScanner?.broadcastMessage(packetJson) { peripheralsSent, peripheralsTotal ->
            val totalDelivered = centralsNotified + peripheralsSent
            val totalConnected = centralTotal + peripheralsTotal
            val result = Arguments.createMap().apply {
                putInt("deliveredCount", totalDelivered)
                putInt("totalNodes", totalConnected)
            }
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for React Native NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for React Native NativeEventEmitter
    }

    @ReactMethod
    fun requestEnableBluetooth(promise: Promise) {
        val adapter = bluetoothAdapter
        if (adapter == null) {
            promise.reject("UNSUPPORTED", "Bluetooth not supported on this device")
            return
        }
        if (adapter.isEnabled) {
            promise.resolve(true)
            return
        }

        try {
            val intent = android.content.Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(false)
        } catch (e: Exception) {
            promise.reject("ENABLE_FAILED", "Failed to launch enable Bluetooth prompt: ${e.message}")
        }
    }

    private fun checkBlePermissions(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val scanGranted = ActivityCompat.checkSelfPermission(
                reactContext,
                Manifest.permission.BLUETOOTH_SCAN
            ) == PackageManager.PERMISSION_GRANTED
            val advGranted = ActivityCompat.checkSelfPermission(
                reactContext,
                Manifest.permission.BLUETOOTH_ADVERTISE
            ) == PackageManager.PERMISSION_GRANTED
            val connectGranted = ActivityCompat.checkSelfPermission(
                reactContext,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED

            scanGranted && advGranted && connectGranted
        } else {
            val btGranted = ActivityCompat.checkSelfPermission(
                reactContext,
                Manifest.permission.BLUETOOTH
            ) == PackageManager.PERMISSION_GRANTED
            val locGranted = ActivityCompat.checkSelfPermission(
                reactContext,
                Manifest.permission.ACCESS_FINE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED

            btGranted && locGranted
        }
    }
}

