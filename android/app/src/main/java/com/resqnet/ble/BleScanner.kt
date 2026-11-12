package com.resqnet.ble

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

class BleScanner(
    private val context: Context,
    private val bluetoothAdapter: BluetoothAdapter?,
    private val onNodeDiscovered: (address: String, name: String, nodeId: String, rssi: Int, txPower: Int) -> Unit,
    private val onNodeConnected: (address: String, nodeId: String, name: String) -> Unit,
    private val onNodeDisconnected: (address: String) -> Unit,
    private val onMessageReceived: (senderAddress: String, payload: String) -> Unit,
    private val onScanStateChanged: (isScanning: Boolean) -> Unit
) {
    private val TAG = "ResQNetScanner"
    private var isScanning = false
    private var shouldBeScanning = false
    private var autoConnectEnabled = true
    private var scanIntervalMs: Long = 25000
    private var lastScanStartMs: Long = 0L

    private val mainHandler = Handler(Looper.getMainLooper())
    private var periodicScanRunnable: Runnable? = null
    private var scanWatchdogRunnable: Runnable? = null

    // Track fully ready GATT client connections where services have been discovered
    private val readyGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val pendingGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val connectionWatchdogs = ConcurrentHashMap<String, Runnable>()
    private val discoveryWatchdogs = ConcurrentHashMap<String, Runnable>()
    private val discoveredNodes = ConcurrentHashMap<String, DiscoveredNodeInfo>()
    private val negotiatedMtus = ConcurrentHashMap<String, Int>()
    private val lastConnectAttempt = ConcurrentHashMap<String, Long>()

    // Sequential write queue per device address to prevent concurrent GATT write collisions
    data class QueuedWrite(
        val targetAddress: String,
        val packetJson: String,
        val callback: (Boolean, String?) -> Unit,
        var retryCount: Int = 0
    )
    private val writeQueues = ConcurrentHashMap<String, ConcurrentLinkedQueue<QueuedWrite>>()
    private val inFlightWrites = ConcurrentHashMap<String, QueuedWrite>()
    private val writeWatchdogs = ConcurrentHashMap<String, Runnable>()

    // Lookup to check if peer is already connected as Central on our GATT server
    var isCentralConnectedLookup: ((String) -> Boolean)? = null

    // Lookup to check our own local device ID to filter out self-advertisements
    var localDeviceIdLookup: (() -> String?)? = null

    // Lookup to check our own local username to filter out self-advertisements
    var localUsernameLookup: (() -> String?)? = null

    data class DiscoveredNodeInfo(
        val address: String,
        val name: String,
        val nodeId: String,
        var rssi: Int,
        var lastSeen: Long
    )

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            result ?: return
            val device = result.device ?: return
            val record = result.scanRecord ?: return

            val mfgData = record.getManufacturerSpecificData(ResQNetConstants.MANUFACTURER_ID)
            val hasResQNetService = record.serviceUuids?.any { it.uuid == ResQNetConstants.SERVICE_UUID } == true
            val hasResQNetMfg = mfgData != null && mfgData.isNotEmpty()

            // STRICT APP-ONLY FILTER: Discard all ambient Bluetooth gadgets (smartwatches, TVs, headphones, beacons)
            // ONLY accept devices that actively broadcast ResQNet service UUID or ResQNet manufacturer data
            if (!hasResQNetService && !hasResQNetMfg) {
                return
            }

            var parsedDeviceId: String? = null
            var parsedUsername: String? = null

            if (mfgData != null && mfgData.isNotEmpty()) {
                try {
                    val rawStr = String(mfgData, StandardCharsets.UTF_8).trim()
                    if (rawStr.startsWith("E:") || rawStr.startsWith("R:")) {
                        val parts = rawStr.split(":")
                        if (parts.size >= 2 && parts[1].isNotBlank()) {
                            parsedDeviceId = "ERVO-${parts[1].trim()}"
                        }
                        if (parts.size >= 3 && parts[2].isNotBlank()) {
                            parsedUsername = parts[2].trim()
                        }
                    }
                } catch (e: Exception) { null }
            }

            // Check if we already have a verified manufacturer signature cached for this address
            val cachedNode = discoveredNodes[device.address]
            val assignedDeviceId = parsedDeviceId ?: cachedNode?.nodeId
            val finalUsername = parsedUsername ?: cachedNode?.name

            // STRICT APP-ONLY FILTER: Discard any peripheral that does not carry the verified ERVONET signature
            // NEVER invent fallback devices from random Bluetooth MAC addresses
            if (assignedDeviceId == null) {
                return
            }

            val effectiveDeviceId = assignedDeviceId
            val effectiveUsername = finalUsername ?: effectiveDeviceId

            // STRICT SELF-FILTER: Immediately discard our own device if picked up by scanner
            val myLocalId = localDeviceIdLookup?.invoke()
            val myLocalName = localUsernameLookup?.invoke()

            if (!myLocalId.isNullOrEmpty()) {
                val cleanMyId = myLocalId.replace("ERVO-", "").replace("RESQ-", "").trim()
                val cleanPeerId = effectiveDeviceId.replace("ERVO-", "").replace("RESQ-", "").trim()
                if (cleanMyId.equals(cleanPeerId, ignoreCase = true)) {
                    return
                }
            }

            if (!myLocalName.isNullOrEmpty()) {
                if (effectiveUsername.equals(myLocalName.trim(), ignoreCase = true) ||
                    (parsedUsername != null && parsedUsername.equals(myLocalName.trim(), ignoreCase = true))) {
                    return
                }
            }

            val nodeId = effectiveDeviceId
            val devName = effectiveUsername
            val rssi = result.rssi
            val txPower = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                result.txPower
            } else {
                -59
            }

            discoveredNodes[device.address] = DiscoveredNodeInfo(
                address = device.address,
                name = devName,
                nodeId = nodeId,
                rssi = rssi,
                lastSeen = System.currentTimeMillis()
            )

            onNodeDiscovered(device.address, devName, nodeId, rssi, txPower)

            // Auto-connect to real ResQNet app peers if not already connected or connecting
            if (autoConnectEnabled) {
                val isAlreadyConnected = readyGatts.containsKey(device.address)
                val isAlreadyConnecting = pendingGatts.containsKey(device.address)
                val recentlyAttempted = System.currentTimeMillis() - (lastConnectAttempt[device.address] ?: 0L) < 1200L

                if (!isAlreadyConnected && !isAlreadyConnecting && !recentlyAttempted) {
                    Log.d(TAG, "Auto-connecting to discovered node: ${device.address} ($devName, $nodeId)")
                    connect(device.address)
                }
            }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>?) {
            results?.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG, "BLE Scan failed with errorCode: $errorCode")
            isScanning = false
            onScanStateChanged(false)

            // Auto-recovery watchdog: automatically restart scanner
            if (shouldBeScanning && getActiveAdapter()?.isEnabled == true) {
                mainHandler.postDelayed({
                    if (shouldBeScanning && !isScanning) {
                        Log.d(TAG, "Auto-recovering BLE scanner after failure...")
                        startScan(autoConnectEnabled, true)
                    }
                }, 1500)
            }
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            Log.d(TAG, "GATT Client connection changed: $address, status=$status, newState=$newState")

            // Cancel connection watchdog and any prior discovery watchdog
            connectionWatchdogs.remove(address)?.let { mainHandler.removeCallbacks(it) }
            discoveryWatchdogs.remove(address)?.let { mainHandler.removeCallbacks(it) }

            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                pendingGatts[address] = gatt

                // Discovery watchdog: ensure hung MTU / service discovery never wedges pendingGatts permanently
                val discWatchdog = Runnable {
                    if (pendingGatts.containsKey(address) && !readyGatts.containsKey(address)) {
                        Log.w(TAG, "Discovery watchdog: handshake timed out for $address, closing GATT...")
                        val hungGatt = pendingGatts.remove(address)
                        try {
                            hungGatt?.disconnect()
                            hungGatt?.close()
                        } catch (e: Exception) {}
                        onNodeDisconnected(address)
                    }
                }
                discoveryWatchdogs[address] = discWatchdog
                mainHandler.postDelayed(discWatchdog, 6000)

                // 1. Immediately request 2M High-Speed PHY (BLE 5.0) if supported (doubles throughput to 2 Mbps)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    try {
                        gatt.setPreferredPhy(
                            BluetoothDevice.PHY_LE_2M_MASK,
                            BluetoothDevice.PHY_LE_2M_MASK,
                            BluetoothDevice.PHY_OPTION_NO_PREFERRED
                        )
                        Log.d(TAG, "Client requested 2M High-Speed PHY for $address")
                    } catch (e: Exception) {
                        Log.w(TAG, "setPreferredPhy notice: ${e.message}")
                    }
                }

                // 2. Immediately request high connection priority for minimal packet latency (11.25-15ms interval)
                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                } catch (e: Exception) {
                    Log.w(TAG, "Could not request CONNECTION_PRIORITY_HIGH: ${e.message}")
                }

                // 3. Fast MTU 512 request after 40ms to maximize payload capacity (99% packets fit in 1 frame)
                mainHandler.postDelayed({
                    if (pendingGatts.containsKey(address) && !readyGatts.containsKey(address)) {
                        val requested = gatt.requestMtu(512)
                        if (!requested) {
                            Log.w(TAG, "requestMtu returned false, proceeding immediately to discoverServices for $address")
                            gatt.discoverServices()
                        }
                    }
                }, 40)

                // Fallback: If neither onMtuChanged nor onServicesDiscovered fires within 1200ms, force discoverServices
                mainHandler.postDelayed({
                    if (pendingGatts.containsKey(address) && !readyGatts.containsKey(address) && gatt.services.isEmpty()) {
                        Log.d(TAG, "MTU callback timed out, fallback to discoverServices for $address")
                        gatt.discoverServices()
                    }
                }, 1200)

            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                pendingGatts.remove(address)
                readyGatts.remove(address)
                negotiatedMtus.remove(address)

                // Purge in-flight and queued writes
                writeWatchdogs.remove(address)?.let { mainHandler.removeCallbacks(it) }
                val inFlight = inFlightWrites.remove(address)
                inFlight?.callback?.invoke(false, "Disconnected or connection failed status=$status")
                val queue = writeQueues.remove(address)
                while (queue != null && !queue.isEmpty()) {
                    queue.poll()?.callback?.invoke(false, "Disconnected")
                }

                try {
                    gatt.disconnect()
                    gatt.close()
                } catch (e: Exception) {
                    Log.e(TAG, "Error closing gatt: ${e.message}")
                }
                onNodeDisconnected(address)

                // Fast auto-reconnect to recently active peer in 500ms if auto-connect is on
                if (autoConnectEnabled && shouldBeScanning) {
                    val nodeInfo = discoveredNodes[address]
                    val seenRecently = nodeInfo != null && (System.currentTimeMillis() - nodeInfo.lastSeen < 60000L)
                    if (seenRecently) {
                        Log.d(TAG, "Node $address disconnected, scheduling fast auto-reconnect in 500ms...")
                        mainHandler.postDelayed({
                            if (shouldBeScanning && autoConnectEnabled && !readyGatts.containsKey(address) && !pendingGatts.containsKey(address)) {
                                connect(address)
                            }
                        }, 500)
                    }
                }
            }
        }

        override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) {
            val address = gatt.device.address
            val is2M = txPhy == BluetoothDevice.PHY_LE_2M && rxPhy == BluetoothDevice.PHY_LE_2M
            Log.d(TAG, "GATT Client onPhyUpdate for $address: txPhy=$txPhy, rxPhy=$rxPhy (2M High-Speed=$is2M), status=$status")
        }

        @SuppressLint("MissingPermission")
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val address = gatt.device.address
            Log.d(TAG, "GATT onMtuChanged for $address: mtu=$mtu, status=$status")
            negotiatedMtus[address] = if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23
            // Re-assert high priority to ensure OS doesn't relax connection interval
            try {
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            } catch (e: Exception) {}
            // Now that MTU handshake finished, discover services cleanly
            gatt.discoverServices()
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val address = gatt.device.address
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.d(TAG, "GATT Services discovered successfully for $address")
                // Re-assert high priority
                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                } catch (e: Exception) {}

                val service = gatt.getService(ResQNetConstants.SERVICE_UUID)
                if (service != null) {
                    val txChar = service.getCharacteristic(ResQNetConstants.CHAR_TX_MESSAGE_UUID)
                    var descriptorWriteStarted = false
                    if (txChar != null) {
                        gatt.setCharacteristicNotification(txChar, true)
                        val cccd = txChar.getDescriptor(ResQNetConstants.CCCD_UUID)
                        if (cccd != null) {
                            val writeStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                val res = gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                                res == BluetoothStatusCodes.SUCCESS
                            } else {
                                cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                                gatt.writeDescriptor(cccd)
                            }
                            if (writeStatus) {
                                descriptorWriteStarted = true
                                Log.d(TAG, "CCCD descriptor write initiated for $address, awaiting onDescriptorWrite")
                            }
                        }
                    }

                    if (!descriptorWriteStarted) {
                        Log.d(TAG, "No CCCD or descriptor write failed to initiate for $address, marking ready immediately")
                        markGattReadyAndNotify(gatt)
                    }
                } else {
                    Log.e(TAG, "ResQNet service UUID not found on $address, closing GATT cleanly")
                    discoveryWatchdogs.remove(address)?.let { mainHandler.removeCallbacks(it) }
                    pendingGatts.remove(address)
                    try {
                        gatt.disconnect()
                        gatt.close()
                    } catch (e: Exception) {}
                    onNodeDisconnected(address)
                }
            } else {
                Log.e(TAG, "Service discovery failed with status $status on $address, closing GATT cleanly")
                discoveryWatchdogs.remove(address)?.let { mainHandler.removeCallbacks(it) }
                pendingGatts.remove(address)
                try {
                    gatt.disconnect()
                    gatt.close()
                } catch (e: Exception) {}
                onNodeDisconnected(address)
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            val address = gatt.device.address
            Log.d(TAG, "GATT onDescriptorWrite for $address, status=$status, desc=${descriptor.uuid}")
            // Re-assert high priority to keep link locked at 11.25ms interval
            try {
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            } catch (e: Exception) {}
            markGattReadyAndNotify(gatt)
        }

        // Android 12 and below
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            handleCharacteristicChanged(gatt.device.address, characteristic.uuid, characteristic.value)
        }

        // Android 13+ (API 33+)
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handleCharacteristicChanged(gatt.device.address, characteristic.uuid, value)
        }

        private fun handleCharacteristicChanged(deviceAddress: String, uuid: UUID, value: ByteArray?) {
            if (uuid == ResQNetConstants.CHAR_TX_MESSAGE_UUID) {
                val payload = value?.let { String(it, StandardCharsets.UTF_8) } ?: ""
                Log.d(TAG, "GATT Client received notification from $deviceAddress: $payload")
                if (payload.isNotEmpty()) {
                    onMessageReceived(deviceAddress, payload)
                }
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            val address = gatt.device.address
            val watchdog = writeWatchdogs.remove(address)
            if (watchdog != null) {
                mainHandler.removeCallbacks(watchdog)
            }

            val completedWrite = inFlightWrites.remove(address)
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.d(TAG, "GATT writeCharacteristic SUCCESS to $address")
                completedWrite?.callback?.invoke(true, null)
            } else {
                Log.e(TAG, "GATT writeCharacteristic FAILED to $address with status $status")
                completedWrite?.callback?.invoke(false, "Write failed with status $status")
            }

            // Immediately dispatch next queued write for this node
            processNextWrite(address)
        }
    }

    private fun markGattReadyAndNotify(gatt: BluetoothGatt) {
        val address = gatt.device.address
        discoveryWatchdogs.remove(address)?.let { mainHandler.removeCallbacks(it) }
        if (readyGatts.containsKey(address)) {
            return
        }
        pendingGatts.remove(address)
        readyGatts[address] = gatt

        val nodeInfo = discoveredNodes[address]
        val nodeId = nodeInfo?.nodeId ?: "ERVO-${address.takeLast(4).replace(":", "").uppercase()}"
        val name = nodeInfo?.name ?: nodeId

        val myLocalId = localDeviceIdLookup?.invoke()
        if (!myLocalId.isNullOrEmpty() && nodeId.equals(myLocalId, ignoreCase = true)) {
            return
        }

        Log.i(TAG, "Node fully ready for bidirectional transmission: $address ($name, $nodeId)")
        onNodeConnected(address, nodeId, name)

        // Process any queued writes waiting for this node
        processNextWrite(address)
    }

    private fun getActiveAdapter(): BluetoothAdapter? {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return manager?.adapter ?: bluetoothAdapter ?: BluetoothAdapter.getDefaultAdapter()
    }

    @SuppressLint("MissingPermission")
    fun startScan(autoConnect: Boolean = true, continuous: Boolean = true): Boolean {
        val adapter = getActiveAdapter()
        if (adapter == null || !adapter.isEnabled) {
            Log.e(TAG, "Bluetooth not available or enabled")
            return false
        }

        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            Log.e(TAG, "BluetoothLeScanner not available")
            return false
        }

        autoConnectEnabled = autoConnect
        shouldBeScanning = true

        if (isScanning) {
            Log.d(TAG, "BLE Scan already active, preserving continuous session")
            startWatchdog()
            return true
        }

        startWatchdog()

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)
            .build()

        try {
            val filters = mutableListOf<ScanFilter>()
            try {
                filters.add(
                    ScanFilter.Builder()
                        .setServiceUuid(ParcelUuid(ResQNetConstants.SERVICE_UUID))
                        .build()
                )
                filters.add(
                    ScanFilter.Builder()
                        .setManufacturerData(ResQNetConstants.MANUFACTURER_ID, byteArrayOf())
                        .build()
                )
            } catch (e: Exception) {
                Log.w(TAG, "Hardware scan filter setup: ${e.message}")
            }
            scanner.startScan(filters, settings, scanCallback)
            isScanning = true
            lastScanStartMs = System.currentTimeMillis()
            onScanStateChanged(true)
            Log.d(TAG, "BLE Scan started (hardware filtered for ResQNet)")

            if (continuous) {
                schedulePeriodicCycle()
            }
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Exception starting scan: ${e.message}")
            return false
        }
    }

    private fun startWatchdog() {
        scanWatchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        scanWatchdogRunnable = object : Runnable {
            override fun run() {
                if (shouldBeScanning) {
                    val adapter = getActiveAdapter()
                    if (adapter != null && adapter.isEnabled && !isScanning) {
                        Log.d(TAG, "Scan watchdog: scanner was inactive, auto-restarting...")
                        startScan(autoConnectEnabled, true)
                    }
                    mainHandler.postDelayed(this, 4000)
                }
            }
        }
        mainHandler.postDelayed(scanWatchdogRunnable!!, 4000)
    }

    private fun schedulePeriodicCycle() {
        periodicScanRunnable?.let { mainHandler.removeCallbacks(it) }
        periodicScanRunnable = Runnable {
            if (shouldBeScanning && isScanning) {
                // Periodically cycle scan (stop, pause 100ms, restart) to defeat Android BLE continuous scan throttling
                try {
                    getActiveAdapter()?.bluetoothLeScanner?.stopScan(scanCallback)
                    isScanning = false
                    mainHandler.postDelayed({
                        if (shouldBeScanning) {
                            startScan(autoConnectEnabled, true)
                        }
                    }, 100)
                } catch (e: Exception) {
                    Log.w(TAG, "Scan cycle refresh notice: ${e.message}")
                }
            }
        }
        mainHandler.postDelayed(periodicScanRunnable!!, scanIntervalMs)
    }

    @SuppressLint("MissingPermission")
    fun stopScan() {
        shouldBeScanning = false
        scanWatchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        periodicScanRunnable?.let { mainHandler.removeCallbacks(it) }
        try {
            getActiveAdapter()?.bluetoothLeScanner?.stopScan(scanCallback)
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping scan: ${e.message}")
        }
        isScanning = false
        onScanStateChanged(false)
        Log.d(TAG, "BLE Scan stopped")
    }

    @SuppressLint("MissingPermission")
    fun connect(deviceAddress: String): Boolean {
        val adapter = getActiveAdapter() ?: return false
        val device = try {
            adapter.getRemoteDevice(deviceAddress)
        } catch (e: Exception) {
            Log.e(TAG, "Invalid Bluetooth address: $deviceAddress")
            return false
        }

        lastConnectAttempt[deviceAddress] = System.currentTimeMillis()

        // Only briefly pause scanner if enough cooldown has elapsed so we NEVER trip Android's 5-scans/30s OS throttle
        val shouldPauseScan = isScanning && (System.currentTimeMillis() - lastScanStartMs) > 6500L
        if (shouldPauseScan) {
            try {
                adapter.bluetoothLeScanner?.stopScan(scanCallback)
                isScanning = false
            } catch (e: Exception) {}
        }

        try {
            val gatt = device.connectGatt(
                context,
                false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE
            )
            pendingGatts[deviceAddress] = gatt
            Log.d(TAG, "Initiated connectGatt to $deviceAddress")

            // Resume scanning fast after 150ms if we paused it
            if (shouldPauseScan && shouldBeScanning) {
                mainHandler.postDelayed({
                    if (shouldBeScanning && !isScanning) {
                        startScan(autoConnectEnabled, true)
                    }
                }, 150)
            }

            // Connection watchdog (4000ms): close gatt if hanging
            val watchdog = Runnable {
                if (pendingGatts.containsKey(deviceAddress) && !readyGatts.containsKey(deviceAddress)) {
                    Log.w(TAG, "Connection watchdog: connectGatt to $deviceAddress timed out, closing...")
                    val hangingGatt = pendingGatts.remove(deviceAddress)
                    try {
                        hangingGatt?.disconnect()
                        hangingGatt?.close()
                    } catch (e: Exception) {}
                    lastConnectAttempt.remove(deviceAddress)
                }
            }
            connectionWatchdogs[deviceAddress] = watchdog
            mainHandler.postDelayed(watchdog, 4000)

            return true
        } catch (e: Exception) {
            Log.e(TAG, "Exception connecting to $deviceAddress: ${e.message}")
            if (shouldPauseScan && shouldBeScanning) {
                mainHandler.postDelayed({
                    if (shouldBeScanning && !isScanning) {
                        startScan(autoConnectEnabled, true)
                    }
                }, 150)
            }
            return false
        }
    }

    @SuppressLint("MissingPermission")
    fun disconnect(deviceAddress: String) {
        connectionWatchdogs.remove(deviceAddress)?.let { mainHandler.removeCallbacks(it) }
        discoveryWatchdogs.remove(deviceAddress)?.let { mainHandler.removeCallbacks(it) }
        val pendingGatt = pendingGatts.remove(deviceAddress)
        val gatt = readyGatts.remove(deviceAddress) ?: pendingGatt
        negotiatedMtus.remove(deviceAddress)

        writeWatchdogs.remove(deviceAddress)?.let { mainHandler.removeCallbacks(it) }
        val inFlight = inFlightWrites.remove(deviceAddress)
        inFlight?.callback?.invoke(false, "Disconnected")
        val queue = writeQueues.remove(deviceAddress)
        while (queue != null && !queue.isEmpty()) {
            queue.poll()?.callback?.invoke(false, "Disconnected")
        }

        try {
            gatt?.disconnect()
            gatt?.close()
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting: ${e.message}")
        }
        onNodeDisconnected(deviceAddress)
    }

    @SuppressLint("MissingPermission")
    fun sendMessage(
        targetAddress: String,
        packetJson: String,
        callback: (Boolean, String?) -> Unit
    ) {
        val queue = writeQueues.getOrPut(targetAddress) { ConcurrentLinkedQueue() }
        queue.add(QueuedWrite(targetAddress, packetJson, callback))
        processNextWrite(targetAddress)
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    private fun processNextWrite(targetAddress: String) {
        if (inFlightWrites.containsKey(targetAddress)) {
            return
        }

        val gatt = readyGatts[targetAddress]
        if (gatt == null) {
            if (!pendingGatts.containsKey(targetAddress)) {
                val queue = writeQueues[targetAddress]
                while (queue != null && !queue.isEmpty()) {
                    queue.poll()?.callback?.invoke(false, "Device not connected or ready: $targetAddress")
                }
            }
            return
        }

        val queue = writeQueues[targetAddress] ?: return
        val nextWrite = queue.poll() ?: return

        val service = gatt.getService(ResQNetConstants.SERVICE_UUID)
        val rxChar = service?.getCharacteristic(ResQNetConstants.CHAR_RX_MESSAGE_UUID)
        if (rxChar == null) {
            nextWrite.callback(false, "RX characteristic not found on $targetAddress")
            processNextWrite(targetAddress)
            return
        }

        inFlightWrites[targetAddress] = nextWrite

        val watchdog = Runnable {
            val timedOut = inFlightWrites.remove(targetAddress)
            if (timedOut != null) {
                Log.w(TAG, "GATT write watchdog expired for $targetAddress")
                timedOut.callback(false, "Write timed out after 4000ms")
                processNextWrite(targetAddress)
            }
        }
        writeWatchdogs[targetAddress] = watchdog
        mainHandler.postDelayed(watchdog, 4000)

        val bytes = nextWrite.packetJson.toByteArray(StandardCharsets.UTF_8)
        var initiated = false

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val res = gatt.writeCharacteristic(rxChar, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                initiated = (res == BluetoothStatusCodes.SUCCESS)
            } else {
                rxChar.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                rxChar.value = bytes
                initiated = gatt.writeCharacteristic(rxChar)
            }
        } catch (e: Exception) {
            Log.w(TAG, "writeCharacteristic threw exception: ${e.message}")
            initiated = false
        }

        if (!initiated) {
            mainHandler.removeCallbacks(watchdog)
            writeWatchdogs.remove(targetAddress)
            inFlightWrites.remove(targetAddress)

            if (nextWrite.retryCount < 4) {
                nextWrite.retryCount++
                Log.d(TAG, "GATT busy on $targetAddress, retrying write #${nextWrite.retryCount} in 75ms...")
                mainHandler.postDelayed({
                    val q = writeQueues.getOrPut(targetAddress) { ConcurrentLinkedQueue() }
                    val list = mutableListOf<QueuedWrite>()
                    list.add(nextWrite)
                    while (!q.isEmpty()) {
                        q.poll()?.let { list.add(it) }
                    }
                    for (item in list) {
                        q.add(item)
                    }
                    processNextWrite(targetAddress)
                }, 75)
                return
            }

            Log.w(TAG, "writeCharacteristic failed to initiate after retries on $targetAddress")
            nextWrite.callback(false, "writeCharacteristic failed to initiate")
            processNextWrite(targetAddress)
        }
    }

    @SuppressLint("MissingPermission")
    fun broadcastMessage(
        packetJson: String,
        callback: (Int, Int) -> Unit
    ) {
        val targets = readyGatts.keys.toList()
        val total = targets.size
        if (total == 0) {
            callback(0, 0)
            return
        }

        val remaining = AtomicInteger(total)
        val successful = AtomicInteger(0)

        for (addr in targets) {
            sendMessage(addr, packetJson) { success, _ ->
                if (success) {
                    successful.incrementAndGet()
                }
                if (remaining.decrementAndGet() == 0) {
                    callback(successful.get(), total)
                }
            }
        }
    }

    fun isConnected(deviceAddress: String): Boolean = readyGatts.containsKey(deviceAddress)
    fun isCurrentlyScanning(): Boolean = isScanning
    fun getConnectedNodes(): List<String> = readyGatts.keys.toList()
    fun getDiscoveredNodes(): List<DiscoveredNodeInfo> = discoveredNodes.values.toList()
    fun getDiscoveredNodeName(address: String): String? = discoveredNodes[address]?.name
    fun getAddressForNodeId(nodeId: String): String? {
        val clean = nodeId.trim()
        if (readyGatts.containsKey(clean)) return clean
        if (discoveredNodes.containsKey(clean)) return clean

        val match = discoveredNodes.entries.find {
            it.value.nodeId.equals(clean, ignoreCase = true) ||
            it.value.name.equals(clean, ignoreCase = true)
        }?.key
        if (match != null) return match

        // Suffix / stripped match (e.g. "4A1B" for "ERVO-4A1B")
        val stripped = clean.replace("ERVO-", "").replace("RESQ-", "")
        if (stripped.isNotBlank()) {
            val suffixMatch = discoveredNodes.entries.find {
                it.value.nodeId.contains(stripped, ignoreCase = true) ||
                it.key.replace(":", "").endsWith(stripped, ignoreCase = true)
            }?.key
            if (suffixMatch != null) return suffixMatch
        }

        // Only fall back to single ready GATT peer if its nodeId isn't already known to be a DIFFERENT node
        if (clean != "BROADCAST" && clean != "#all" && !clean.startsWith("#") && readyGatts.size == 1) {
            val singleAddr = readyGatts.keys.first()
            val knownNode = discoveredNodes[singleAddr]
            if (knownNode == null || knownNode.nodeId.equals(clean, ignoreCase = true) || knownNode.name.equals(clean, ignoreCase = true)) {
                return singleAddr
            }
        }

        return null
    }
}
