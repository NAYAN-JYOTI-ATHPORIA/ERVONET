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
    private var autoConnectEnabled = true
    private var scanIntervalMs: Long = 10000

    private val mainHandler = Handler(Looper.getMainLooper())
    private var periodicScanRunnable: Runnable? = null

    // Track fully ready GATT client connections where services have been discovered
    private val readyGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val pendingGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val discoveredNodes = ConcurrentHashMap<String, DiscoveredNodeInfo>()
    private val negotiatedMtus = ConcurrentHashMap<String, Int>()
    private val lastConnectAttempt = ConcurrentHashMap<String, Long>()

    // Sequential write queue per device address to prevent concurrent GATT write collisions
    data class QueuedWrite(
        val targetAddress: String,
        val packetJson: String,
        val callback: (Boolean, String?) -> Unit
    )
    private val writeQueues = ConcurrentHashMap<String, ConcurrentLinkedQueue<QueuedWrite>>()
    private val inFlightWrites = ConcurrentHashMap<String, QueuedWrite>()
    private val writeWatchdogs = ConcurrentHashMap<String, Runnable>()

    // Lookup to check if peer is already connected as Central on our GATT server
    var isCentralConnectedLookup: ((String) -> Boolean)? = null

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

            if (hasResQNetMfg && mfgData != null) {
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
                    } else if (rawStr.isNotBlank()) {
                        parsedUsername = rawStr
                    }
                } catch (e: Exception) { null }
            }

            val fallbackDeviceId = "ERVO-${device.address.takeLast(4).replace(":", "").uppercase()}"
            val assignedDeviceId = parsedDeviceId ?: fallbackDeviceId
            val finalUsername = parsedUsername ?: assignedDeviceId

            val nodeId = assignedDeviceId
            val devName = finalUsername
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
                val isAlreadyCentral = isCentralConnectedLookup?.invoke(device.address) == true
                val isAlreadyConnected = readyGatts.containsKey(device.address)
                val isAlreadyConnecting = pendingGatts.containsKey(device.address)
                val recentlyAttempted = System.currentTimeMillis() - (lastConnectAttempt[device.address] ?: 0L) < 3000L

                if (!isAlreadyCentral && !isAlreadyConnected && !isAlreadyConnecting && !recentlyAttempted) {
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
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            Log.d(TAG, "GATT Client connection changed: $address, status=$status, newState=$newState")

            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                pendingGatts[address] = gatt

                // Slight delay of 150ms before requesting MTU 512 to ensure GATT baseband link is stable
                mainHandler.postDelayed({
                    if (pendingGatts.containsKey(address) && !readyGatts.containsKey(address)) {
                        val requested = gatt.requestMtu(512)
                        if (!requested) {
                            Log.w(TAG, "requestMtu returned false, proceeding immediately to discoverServices for $address")
                            gatt.discoverServices()
                        }
                    }
                }, 150)

                // Fallback: If neither onMtuChanged nor onServicesDiscovered fires within 1500ms, force discoverServices
                mainHandler.postDelayed({
                    if (pendingGatts.containsKey(address) && !readyGatts.containsKey(address) && gatt.services.isEmpty()) {
                        Log.d(TAG, "MTU callback timed out, fallback to discoverServices for $address")
                        gatt.discoverServices()
                    }
                }, 1500)

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
            }
        }

        @SuppressLint("MissingPermission")
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val address = gatt.device.address
            Log.d(TAG, "GATT onMtuChanged for $address: mtu=$mtu, status=$status")
            negotiatedMtus[address] = if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23
            // Now that MTU handshake finished, discover services cleanly
            gatt.discoverServices()
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val address = gatt.device.address
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.d(TAG, "GATT Services discovered successfully for $address")
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
                    Log.e(TAG, "ResQNet service UUID not found on $address")
                }
            } else {
                Log.e(TAG, "Service discovery failed with status $status on $address")
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            val address = gatt.device.address
            Log.d(TAG, "GATT onDescriptorWrite for $address, status=$status, desc=${descriptor.uuid}")
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
        if (readyGatts.containsKey(address)) {
            return
        }
        pendingGatts.remove(address)
        readyGatts[address] = gatt

        val nodeInfo = discoveredNodes[address]
        val nodeId = nodeInfo?.nodeId ?: "ERVO-${address.takeLast(4).replace(":", "").uppercase()}"
        val name = nodeInfo?.name ?: nodeId
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

    private fun schedulePeriodicCycle() {
        periodicScanRunnable?.let { mainHandler.removeCallbacks(it) }
        periodicScanRunnable = Runnable {
            if (isScanning) {
                schedulePeriodicCycle()
            }
        }
        mainHandler.postDelayed(periodicScanRunnable!!, scanIntervalMs)
    }

    @SuppressLint("MissingPermission")
    fun stopScan() {
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

        try {
            val gatt = device.connectGatt(
                context,
                false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE
            )
            pendingGatts[deviceAddress] = gatt
            Log.d(TAG, "Initiated connectGatt to $deviceAddress")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Exception connecting to $deviceAddress: ${e.message}")
            return false
        }
    }

    @SuppressLint("MissingPermission")
    fun disconnect(deviceAddress: String) {
        pendingGatts.remove(deviceAddress)
        val gatt = readyGatts.remove(deviceAddress)
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
        val initiated = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val res = gatt.writeCharacteristic(rxChar, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
            res == BluetoothStatusCodes.SUCCESS
        } else {
            rxChar.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            rxChar.value = bytes
            gatt.writeCharacteristic(rxChar)
        }

        if (!initiated) {
            mainHandler.removeCallbacks(watchdog)
            writeWatchdogs.remove(targetAddress)
            inFlightWrites.remove(targetAddress)
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
}
