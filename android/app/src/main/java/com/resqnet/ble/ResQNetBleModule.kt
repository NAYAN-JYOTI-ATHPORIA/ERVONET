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

    private val btStateReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: android.content.Intent?) {
            if (intent?.action == BluetoothAdapter.ACTION_STATE_CHANGED) {
                val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                val isEnabled = state == BluetoothAdapter.STATE_ON
                val params = Arguments.createMap().apply {
                    putBoolean("isEnabled", isEnabled)
                    putInt("state", state)
                }
                sendEvent(ResQNetConstants.EVENT_BLUETOOTH_STATE_CHANGED, params)
            }
        }
    }

    init {
        initializeBle()
        try {
            val filter = android.content.IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(btStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                reactContext.registerReceiver(btStateReceiver, filter)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register btStateReceiver", e)
        }
    }

    override fun invalidate() {
        super.invalidate()
        try {
            reactContext.unregisterReceiver(btStateReceiver)
        } catch (e: Exception) {
            // ignore
        }
        try {
            bleScanner?.stopScan()
            bleAdvertiser?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping BLE components on invalidate", e)
        }
        try {
            val locManager = reactContext.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
            locManager?.removeUpdates(nativeLocationListener)
        } catch (e: Exception) {
            // ignore
        }
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

        // Link local device ID and username to scanner to filter out self-advertisements
        bleScanner?.localDeviceIdLookup = {
            getOrCreateFixedDeviceId()
        }
        bleScanner?.localUsernameLookup = {
            val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
            prefs.getString("SAVED_USERNAME", "")
        }
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        try {
            if (reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(eventName, params)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Dropped event $eventName during lifecycle transition", e)
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
    fun connect(deviceAddress: String, promise: Promise) {
        if (!checkBlePermissions()) {
            promise.reject("PERMISSION_DENIED", "Bluetooth permissions not granted")
            return
        }

        val resolvedAddress = bleScanner?.getAddressForNodeId(deviceAddress) ?: deviceAddress
        val started = bleScanner?.connect(resolvedAddress) ?: false
        if (started) {
            promise.resolve(true)
        } else {
            promise.reject("CONNECT_FAILED", "Could not start connection to $deviceAddress")
        }
    }

    @ReactMethod
    fun disconnect(deviceAddress: String, promise: Promise) {
        val resolvedAddress = bleScanner?.getAddressForNodeId(deviceAddress) ?: deviceAddress
        bleScanner?.disconnect(resolvedAddress)
        promise.resolve(true)
    }

    @ReactMethod
    fun sendMessage(targetAddress: String, packetJson: String, promise: Promise) {
        val startTime = System.currentTimeMillis()
        val resolvedAddress = bleScanner?.getAddressForNodeId(targetAddress) ?: targetAddress

        // 1. If connected as GATT Client (we write to peripheral's RX characteristic)
        val clientAddr = when {
            bleScanner?.isConnected(resolvedAddress) == true -> resolvedAddress
            bleScanner?.isConnected(targetAddress) == true -> targetAddress
            else -> null
        }

        if (clientAddr != null && bleScanner?.isConnected(clientAddr) == true) {
            bleScanner?.sendMessage(clientAddr, packetJson) { success, error ->
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
        val advertiserTarget = when {
            bleAdvertiser?.isCentralConnected(resolvedAddress) == true -> resolvedAddress
            bleAdvertiser?.isCentralConnected(targetAddress) == true -> targetAddress
            else -> null
        }
        if (advertiserTarget != null) {
            val success = bleAdvertiser?.sendMessageToCentral(advertiserTarget, packetJson) ?: false
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
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                try {
                    @Suppress("DEPRECATION")
                    adapter.enable()
                } catch (se: SecurityException) {
                    // Ignore and fall back to intent
                }
            }

            val intent = android.content.Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(false)
        } catch (e: Exception) {
            try {
                val settingsIntent = android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(settingsIntent)
                promise.resolve(false)
            } catch (se: Exception) {
                promise.reject("ENABLE_FAILED", "Failed to launch enable Bluetooth prompt: ${e.message}")
            }
        }
    }

    @ReactMethod
    fun openBluetoothSettings(promise: Promise) {
        try {
            val intent = android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SETTINGS_ERR", e.message)
        }
    }

    private val nativeLocationListener = object : android.location.LocationListener {
        override fun onLocationChanged(location: android.location.Location) {
            try {
                val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
                prefs.edit()
                    .putString("SAVED_LOC_LAT", location.latitude.toString())
                    .putString("SAVED_LOC_LNG", location.longitude.toString())
                    .putFloat("SAVED_LOC_ACC", location.accuracy)
                    .putLong("SAVED_LOC_TIME", location.time)
                    .apply()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to cache location to prefs", e)
            }

            val params = Arguments.createMap().apply {
                putDouble("latitude", location.latitude)
                putDouble("longitude", location.longitude)
                putDouble("accuracy", location.accuracy.toDouble())
                putDouble("timestamp", location.time.toDouble())
            }
            sendEvent(ResQNetConstants.EVENT_LOCATION_UPDATED, params)
        }
        override fun onProviderDisabled(provider: String) {}
        override fun onProviderEnabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
    }

    private fun hasLocationPermission(): Boolean {
        val hasFine = ActivityCompat.checkSelfPermission(
            reactContext,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val hasCoarse = ActivityCompat.checkSelfPermission(
            reactContext,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return hasFine || hasCoarse
    }

    private fun getBestCachedLocationMap(locManager: android.location.LocationManager): WritableMap? {
        val providers = listOf(
            android.location.LocationManager.GPS_PROVIDER,
            android.location.LocationManager.NETWORK_PROVIDER,
            android.location.LocationManager.PASSIVE_PROVIDER
        )

        var bestLoc: android.location.Location? = null
        for (provider in providers) {
            try {
                val loc = locManager.getLastKnownLocation(provider)
                if (loc != null && (bestLoc == null || loc.time > bestLoc.time)) {
                    bestLoc = loc
                }
            } catch (e: SecurityException) {}
        }

        if (bestLoc != null) {
            return Arguments.createMap().apply {
                putDouble("latitude", bestLoc.latitude)
                putDouble("longitude", bestLoc.longitude)
                putDouble("accuracy", bestLoc.accuracy.toDouble())
                putDouble("timestamp", bestLoc.time.toDouble())
            }
        }

        // Fallback to permanent SharedPreferences cache
        val prefs = reactContext.getSharedPreferences("ErvoNetPrefs", Context.MODE_PRIVATE)
        val latStr = prefs.getString("SAVED_LOC_LAT", null)
        val lngStr = prefs.getString("SAVED_LOC_LNG", null)
        val acc = prefs.getFloat("SAVED_LOC_ACC", 10f)
        val time = prefs.getLong("SAVED_LOC_TIME", System.currentTimeMillis())
        if (!latStr.isNullOrEmpty() && !lngStr.isNullOrEmpty()) {
            val lat = latStr.toDoubleOrNull()
            val lng = lngStr.toDoubleOrNull()
            if (lat != null && lng != null) {
                return Arguments.createMap().apply {
                    putDouble("latitude", lat)
                    putDouble("longitude", lng)
                    putDouble("accuracy", acc.toDouble())
                    putDouble("timestamp", time.toDouble())
                }
            }
        }

        return null
    }

    @ReactMethod
    fun startLocationUpdates(promise: Promise) {
        try {
            val locManager = reactContext.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
            if (locManager == null || !hasLocationPermission()) {
                promise.resolve(false)
                return
            }

            val providers = listOf(
                android.location.LocationManager.GPS_PROVIDER,
                android.location.LocationManager.NETWORK_PROVIDER
            )

            var registered = false
            for (provider in providers) {
                try {
                    if (locManager.isProviderEnabled(provider)) {
                        locManager.requestLocationUpdates(
                            provider,
                            1000L,
                            0.5f,
                            nativeLocationListener,
                            android.os.Looper.getMainLooper()
                        )
                        registered = true
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to register provider $provider", e)
                }
            }

            // Immediately emit best available cached location from OS or SharedPreferences
            getBestCachedLocationMap(locManager)?.let { params ->
                sendEvent(ResQNetConstants.EVENT_LOCATION_UPDATED, params)
            }

            promise.resolve(registered)
        } catch (e: Exception) {
            Log.w(TAG, "startLocationUpdates error", e)
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getDeviceLocation(promise: Promise) {
        try {
            val locManager = reactContext.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
            if (locManager == null || !hasLocationPermission()) {
                promise.resolve(null)
                return
            }

            promise.resolve(getBestCachedLocationMap(locManager))
        } catch (e: Exception) {
            Log.w(TAG, "getDeviceLocation error", e)
            promise.resolve(null)
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

    @ReactMethod
    fun shareOfflineMapDatabase(promise: Promise) {
        try {
            val possibleDbs = listOf(
                reactContext.getDatabasePath("mbgl-offline.db"),
                java.io.File(reactContext.filesDir.parentFile, "databases/mbgl-offline.db"),
                reactContext.getDatabasePath("offline.db"),
                java.io.File(reactContext.filesDir.parentFile, "databases/offline.db")
            )

            var foundDb: java.io.File? = null
            for (db in possibleDbs) {
                if (db != null && db.exists() && db.length() > 0) {
                    foundDb = db
                    break
                }
            }

            if (foundDb == null) {
                promise.reject("NO_DB", "No downloaded offline map packs found. Download an offline region first.")
                return
            }

            val exportDir = java.io.File(reactContext.cacheDir, "exports").apply { mkdirs() }
            val exportFile = java.io.File(exportDir, "ervonet_offline_map.db")
            foundDb.copyTo(exportFile, overwrite = true)

            val uri = androidx.core.content.FileProvider.getUriForFile(
                reactContext,
                "${reactContext.packageName}.fileprovider",
                exportFile
            )

            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "application/octet-stream"
                putExtra(android.content.Intent.EXTRA_STREAM, uri)
                putExtra(android.content.Intent.EXTRA_SUBJECT, "ERVONET Offline Vector Map Database")
                putExtra(android.content.Intent.EXTRA_TEXT, "ERVONET Offline Tactical Map Database (sideloadable offline tile pack).")
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            val chooser = android.content.Intent.createChooser(intent, "Share ERVONET Offline Map Data").apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "shareOfflineMapDatabase error", e)
            promise.reject("SHARE_ERR", e.message ?: "Could not share offline map database")
        }
    }
}

