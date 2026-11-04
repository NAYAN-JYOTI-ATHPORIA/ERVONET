import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import {
  Map,
  Camera,
  Marker,
  UserLocation,
  LocationManager,
  OfflineManager,
  type CameraRef,
  type MapRef,
  type OfflinePack,
  type OfflinePackStatus,
  type LngLatBounds,
  type GeolocationPosition,
} from '@maplibre/maplibre-react-native';
import { PeerNode } from '../types/ble';
import { estimateDistanceMeters } from '../utils/distance';

interface OfflineMapLibreProps {
  localNodeId: string;
  localName: string;
  peers: PeerNode[];
  onOpenChat: (targetId: string) => void;
  onConnectPeer?: (address: string) => void;
}

// OpenFreeMap vector tile style endpoints (100% free & open-source)
const OPENFREEMAP_STYLES = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  positron: 'https://tiles.openfreemap.org/styles/positron',
  bright: 'https://tiles.openfreemap.org/styles/bright',
};

type StyleKey = keyof typeof OPENFREEMAP_STYLES;

interface DownloadProgressState {
  percentage: number;
  tiles: number;
  sizeBytes: number;
  statusText: string;
  regionName: string;
}

// Consistent angle derivation based on peer identity string
function deriveAngleFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const deg = Math.abs(hash % 360);
  return (deg * Math.PI) / 180;
}

export const OfflineMapLibre: React.FC<OfflineMapLibreProps> = ({
  localNodeId,
  localName,
  peers,
  onOpenChat,
  onConnectPeer,
}) => {
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);

  // Exact Live GPS Location State
  const [userCoords, setUserCoords] = useState<[number, number] | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'ACQUIRING' | 'LOCKED' | 'DENIED'>('ACQUIRING');
  const hasCenteredRef = useRef<boolean>(false);

  // Fallback coordinate: Tactical Base coordinates [Longitude, Latitude]
  const [centerCoord, setCenterCoord] = useState<[number, number]>([91.7362, 26.1445]); // Regional default
  const [currentZoom, setCurrentZoom] = useState<number>(15);
  const [currentStyle, setCurrentStyle] = useState<StyleKey>('liberty');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Offline Regions state
  const [offlinePacks, setOfflinePacks] = useState<OfflinePack[]>([]);
  const [packStatuses, setPackStatuses] = useState<Record<string, OfflinePackStatus>>({});
  const [showRegionsModal, setShowRegionsModal] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);

  // Selected peer on map
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);

  // The active position: exact GPS when available, else fallback default
  const activePosition: [number, number] = userCoords || centerCoord;

  // Real-time GPS Tracker & Permission Handler
  const startLocationTracking = useCallback(async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);

        const fineGranted =
          granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const coarseGranted =
          granted[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] ===
          PermissionsAndroid.RESULTS.GRANTED;

        if (!fineGranted && !coarseGranted) {
          setGpsStatus('DENIED');
          return;
        }
      }

      setGpsStatus('ACQUIRING');

      // Update on every 1 meter displacement
      LocationManager.setMinDisplacement(1);
      LocationManager.start();

      const handleLocationUpdate = (location: GeolocationPosition) => {
        if (location?.coords) {
          const { longitude, latitude, accuracy } = location.coords;
          setUserCoords([longitude, latitude]);
          setCenterCoord([longitude, latitude]);
          setGpsAccuracy(Math.round(accuracy));
          setGpsStatus('LOCKED');

          // Smoothly fly camera to exact physical position on initial lock
          if (!hasCenteredRef.current) {
            hasCenteredRef.current = true;
            cameraRef.current?.flyTo({
              center: [longitude, latitude],
              zoom: 16,
              duration: 1000,
            });
          }
        }
      };

      LocationManager.addListener(handleLocationUpdate);

      // Check for last known cached fix for instant map centering
      try {
        const lastKnown = await LocationManager.getCurrentPosition();
        if (lastKnown?.coords) {
          handleLocationUpdate(lastKnown);
        }
      } catch (e) {
        console.warn('Initial location notice:', e);
      }

      return () => {
        LocationManager.removeListener(handleLocationUpdate);
      };
    } catch (err) {
      console.warn('Location initialization error:', err);
      setGpsStatus('DENIED');
    }
  }, []);

  // Load existing offline packs from native database
  const loadOfflinePacks = async () => {
    try {
      const packs = await OfflineManager.getPacks();
      setOfflinePacks(packs);

      // Fetch status for each pack
      const statuses: Record<string, OfflinePackStatus> = {};
      for (const pack of packs) {
        try {
          const status = await pack.status();
          statuses[pack.id] = status;
        } catch (e) {
          console.warn('Pack status fetch notice:', e);
        }
      }
      setPackStatuses(statuses);
    } catch (e) {
      console.warn('Error loading offline packs:', e);
    }
  };

  useEffect(() => {
    loadOfflinePacks();
    let cleanupFn: (() => void) | undefined;
    startLocationTracking().then((cleanup) => {
      cleanupFn = cleanup;
    });

    return () => {
      if (cleanupFn) cleanupFn();
    };
  }, [startLocationTracking]);

  // Download an offline region with OpenFreeMap tiles
  const handleDownloadRegion = async (
    name: string,
    bounds: LngLatBounds,
    minZoom = 12,
    maxZoom = 15
  ) => {
    if (isDownloading) {
      Alert.alert('Download In Progress', 'An offline region is currently downloading. Please wait.');
      return;
    }

    try {
      setIsDownloading(true);
      setDownloadProgress({
        percentage: 0,
        tiles: 0,
        sizeBytes: 0,
        statusText: 'Initializing pack...',
        regionName: name,
      });

      const styleUrl = OPENFREEMAP_STYLES[currentStyle];

      await OfflineManager.createPack(
        {
          mapStyle: styleUrl,
          bounds: bounds,
          minZoom: minZoom,
          maxZoom: maxZoom,
          metadata: {
            name: name,
            timestamp: Date.now(),
            style: currentStyle,
          },
        },
        (pack, status) => {
          setDownloadProgress({
            percentage: Math.round(status.percentage),
            tiles: status.completedTileCount,
            sizeBytes: status.completedResourceSize,
            statusText: `${Math.round(status.percentage)}% (${status.completedTileCount} tiles, ${(
              status.completedResourceSize / (1024 * 1024)
            ).toFixed(1)} MB)`,
            regionName: name,
          });

          if (status.state === 'complete') {
            setIsDownloading(false);
            setDownloadProgress(null);
            loadOfflinePacks();
            Alert.alert(
              'Offline Region Saved',
              `"${name}" has been downloaded to device storage. The map can now operate 100% offline without cellular or Wi-Fi.`
            );
          }
        },
        (pack, error) => {
          console.warn('Offline pack download error:', error);
          setIsDownloading(false);
          setDownloadProgress(null);
          Alert.alert('Download Error', error.message || 'Failed to download offline region.');
        }
      );
    } catch (err: any) {
      setIsDownloading(false);
      setDownloadProgress(null);
      Alert.alert('Error', err?.message || 'Could not initiate offline pack creation.');
    }
  };

  // Download current map viewport as an offline region
  const handleDownloadCurrentViewport = async () => {
    try {
      let bounds: LngLatBounds;
      if (mapRef.current) {
        bounds = await mapRef.current.getBounds();
      } else {
        // Fallback bounds around active exact position
        const delta = 0.05;
        bounds = [
          activePosition[0] - delta,
          activePosition[1] - delta,
          activePosition[0] + delta,
          activePosition[1] + delta,
        ];
      }

      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await handleDownloadRegion(`Tactical Sector ${timestamp}`, bounds, 12, 15);
    } catch (e: any) {
      Alert.alert('Viewport Calculation Notice', e?.message || 'Unable to retrieve viewport bounds.');
    }
  };

  // Download a preset regional sector around the user's base
  const handleDownloadPresetSector = async (radiusKm: number, label: string) => {
    const delta = (radiusKm / 111.32);
    const bounds: LngLatBounds = [
      activePosition[0] - delta,
      activePosition[1] - delta,
      activePosition[0] + delta,
      activePosition[1] + delta,
    ];
    await handleDownloadRegion(`${label} (${radiusKm}km)`, bounds, 11, 14);
  };

  // Delete an offline pack
  const handleDeletePack = async (packId: string, packName: string) => {
    Alert.alert(
      'Remove Offline Region',
      `Are you sure you want to delete "${packName}" from device storage?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await OfflineManager.deletePack(packId);
              loadOfflinePacks();
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Could not delete pack.');
            }
          },
        },
      ]
    );
  };

  // Clear ambient temporary tile cache
  const handleClearCache = async () => {
    try {
      await OfflineManager.clearAmbientCache();
      Alert.alert('Cache Cleared', 'Ambient tile cache has been freed.');
    } catch (e: any) {
      Alert.alert('Notice', e?.message || 'Could not clear ambient cache.');
    }
  };

  // Zoom In / Zoom Out
  const handleZoom = (delta: number) => {
    const nextZoom = Math.min(18, Math.max(3, currentZoom + delta));
    setCurrentZoom(nextZoom);
    cameraRef.current?.easeTo({
      center: activePosition,
      zoom: nextZoom,
      duration: 250,
    });
  };

  // Center on local node (YOU) with exact live GPS location
  const handleRecenter = async () => {
    if (userCoords) {
      cameraRef.current?.flyTo({
        center: userCoords,
        zoom: 16,
        duration: 700,
      });
    } else {
      // Re-query current GPS fix
      try {
        const lastKnown = await LocationManager.getCurrentPosition();
        if (lastKnown?.coords) {
          const { longitude, latitude, accuracy } = lastKnown.coords;
          setUserCoords([longitude, latitude]);
          setCenterCoord([longitude, latitude]);
          setGpsAccuracy(Math.round(accuracy));
          setGpsStatus('LOCKED');
          cameraRef.current?.flyTo({
            center: [longitude, latitude],
            zoom: 16,
            duration: 700,
          });
          return;
        }
      } catch (e) {
        console.warn('GPS query error:', e);
      }

      cameraRef.current?.flyTo({
        center: centerCoord,
        zoom: 15,
        duration: 600,
      });
      Alert.alert(
        'Acquiring Location',
        'Acquiring exact GPS satellite fix. Please verify Location is turned ON in phone settings.'
      );
    }
  };

  // Derive geographic latitude/longitude for a peer based on BLE estimated distance and stable bearing
  const getPeerCoordinates = (peer: PeerNode): [number, number] => {
    const dist = peer.rssi ? estimateDistanceMeters(peer.rssi) : 15;
    const angle = deriveAngleFromId(peer.nodeId || peer.id);
    const [uLng, uLat] = activePosition;

    // Approximating meter offsets into latitude/longitude degrees
    // 1 deg latitude ~= 111,320m
    const deltaLat = (dist * Math.cos(angle)) / 111320;
    const deltaLng =
      (dist * Math.sin(angle)) / (111320 * Math.cos((uLat * Math.PI) / 180));

    return [uLng + deltaLng, uLat + deltaLat];
  };

  // Filter peers that have been discovered or connected
  const displayPeers = peers.filter(
    (p) => p.connectionState === 'CONNECTED' || p.connectionState === 'DISCOVERED'
  );

  const selectedPeer = displayPeers.find(
    (p) => p.id === selectedPeerId || p.nodeId === selectedPeerId
  );

  return (
    <View style={[styles.container, isFullscreen && styles.containerFullscreen]}>
      {/* Top Tactical Map Header */}
      <View style={styles.mapHeader}>
        <View style={styles.titleGroup}>
          <View style={styles.offlineLiveDot} />
          <View>
            <Text style={styles.mapTitle}>OFFLINE TACTICAL MAP</Text>
            <Text style={styles.mapSubtitle}>
              MapLibre • OpenFreeMap • {offlinePacks.length} Offline Region(s)
            </Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          {/* Style Selector Pill */}
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={() => {
              const stylesList: StyleKey[] = ['liberty', 'positron', 'bright'];
              const nextIndex = (stylesList.indexOf(currentStyle) + 1) % stylesList.length;
              setCurrentStyle(stylesList[nextIndex]);
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.pillBtnText}>
              {currentStyle.toUpperCase()}
            </Text>
          </TouchableOpacity>

          {/* Offline Regions Manager Button */}
          <TouchableOpacity
            style={[styles.pillBtn, offlinePacks.length > 0 && styles.pillBtnHighlight]}
            onPress={() => setShowRegionsModal(true)}
            activeOpacity={0.7}
          >
            <Text style={styles.pillBtnText}>
              REGIONS ({offlinePacks.length})
            </Text>
          </TouchableOpacity>

          {/* Fullscreen Toggle Button */}
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={() => setIsFullscreen(!isFullscreen)}
            activeOpacity={0.7}
          >
            <Text style={styles.pillBtnText}>
              {isFullscreen ? 'EXIT' : 'FULL'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Map View Canvas */}
      <View style={[styles.mapWrapper, isFullscreen && styles.mapWrapperFullscreen]}>
        <Map
          ref={mapRef}
          style={styles.map}
          mapStyle={OPENFREEMAP_STYLES[currentStyle]}
          dragPan={true}
          touchZoom={true}
          touchRotate={true}
          doubleTapZoom={true}
        >
          <Camera
            ref={cameraRef}
            initialViewState={{
              center: activePosition,
              zoom: currentZoom,
            }}
          />

          {/* Native Vector User Location Puck with Accuracy Halo */}
          <UserLocation animated={true} accuracy={true} heading={false} />

          {/* High-Tech Tactical Beacon Marker for Local User (YOU) */}
          <Marker lngLat={activePosition}>
            <View style={styles.userMarkerContainer}>
              <View style={styles.userMarkerPulse} />
              <View style={styles.userMarkerCore}>
                <Text style={styles.userMarkerText}>YOU</Text>
              </View>
            </View>
          </Marker>

          {/* Peer Nodes Plotted on the Map Relative to Real User Position */}
          {displayPeers.map((peer) => {
            const peerCoords = getPeerCoordinates(peer);
            const isConnected = peer.connectionState === 'CONNECTED';
            const dist = peer.rssi ? estimateDistanceMeters(peer.rssi) : 10;
            const isSelected =
              selectedPeerId === peer.id || selectedPeerId === peer.nodeId;
            const peerInitial = (peer.name?.[0] || peer.nodeId?.[0] || 'U').toUpperCase();

            return (
              <Marker
                key={peer.id}
                lngLat={peerCoords}
                onPress={() => setSelectedPeerId(peer.nodeId || peer.id)}
              >
                <TouchableOpacity
                  style={[
                    styles.peerMarkerContainer,
                    isConnected ? styles.peerMarkerConnected : styles.peerMarkerDiscovered,
                    isSelected && styles.peerMarkerSelected,
                  ]}
                  onPress={() => setSelectedPeerId(peer.nodeId || peer.id)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.peerMarkerText}>{peerInitial}</Text>
                  <View style={styles.peerDistTag}>
                    <Text style={styles.peerDistTagText}>~{dist}m</Text>
                  </View>
                </TouchableOpacity>
              </Marker>
            );
          })}
        </Map>

        {/* Live GPS Lock & Accuracy Overlay Ribbon */}
        <TouchableOpacity
          style={[
            styles.gpsOverlayBadge,
            gpsStatus === 'LOCKED'
              ? styles.gpsOverlayLocked
              : gpsStatus === 'DENIED'
              ? styles.gpsOverlayDenied
              : styles.gpsOverlayAcquiring,
          ]}
          onPress={startLocationTracking}
          activeOpacity={0.8}
        >
          <View
            style={[
              styles.gpsDot,
              gpsStatus === 'LOCKED'
                ? styles.gpsDotGreen
                : gpsStatus === 'DENIED'
                ? styles.gpsDotRed
                : styles.gpsDotAmber,
            ]}
          />
          <Text style={styles.gpsOverlayText} numberOfLines={1}>
            {gpsStatus === 'LOCKED' && userCoords
              ? `GPS FIXED • ${userCoords[1].toFixed(5)}°N, ${userCoords[0].toFixed(5)}°E (±${gpsAccuracy}m)`
              : gpsStatus === 'DENIED'
              ? 'GPS PERMISSION REQUIRED • TAP TO ENABLE'
              : 'ACQUIRING EXACT GPS SATELLITES...'}
          </Text>
        </TouchableOpacity>

        {/* Floating Controls: Zoom In / Zoom Out / Recenter */}
        <View style={styles.floatingControls}>
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={() => handleZoom(1)}
            activeOpacity={0.7}
          >
            <Text style={styles.controlBtnText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={() => handleZoom(-1)}
            activeOpacity={0.7}
          >
            <Text style={styles.controlBtnText}>−</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.controlBtn, styles.controlBtnRecenter]}
            onPress={handleRecenter}
            activeOpacity={0.7}
          >
            <Text style={styles.recenterIcon}>⌖</Text>
          </TouchableOpacity>
        </View>

        {/* Live Download Status Ribbon */}
        {isDownloading && downloadProgress && (
          <View style={styles.downloadRibbon}>
            <ActivityIndicator size="small" color="#38BDF8" />
            <View style={styles.downloadRibbonTextWrap}>
              <Text style={styles.downloadRibbonTitle}>
                Downloading "{downloadProgress.regionName}"
              </Text>
              <Text style={styles.downloadRibbonSub}>
                {downloadProgress.statusText}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Selected Peer Tactical Dossier / Chat Dispatch */}
      {selectedPeer ? (
        <View style={styles.dossierCard}>
          <View style={styles.dossierHeader}>
            <View style={styles.dossierAvatar}>
              <Text style={styles.dossierAvatarText}>
                {(selectedPeer.name?.[0] || selectedPeer.nodeId?.[0] || 'U').toUpperCase()}
              </Text>
            </View>
            <View style={styles.dossierInfo}>
              <View style={styles.dossierTitleRow}>
                <Text style={styles.dossierName} numberOfLines={1}>
                  {selectedPeer.name || selectedPeer.nodeId}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    selectedPeer.connectionState === 'CONNECTED'
                      ? styles.statusPillGreen
                      : styles.statusPillAmber,
                  ]}
                >
                  <Text style={styles.statusPillText}>
                    {selectedPeer.connectionState === 'CONNECTED' ? 'CONNECTED' : 'IN RANGE'}
                  </Text>
                </View>
              </View>
              <Text style={styles.dossierMeta}>
                ID: {selectedPeer.nodeId} • ~
                {selectedPeer.rssi ? estimateDistanceMeters(selectedPeer.rssi) : 10}m •{' '}
                {selectedPeer.rssi || -75} dBm
              </Text>
            </View>
          </View>

          <View style={styles.dossierActionRow}>
            {selectedPeer.connectionState !== 'CONNECTED' && onConnectPeer && (
              <TouchableOpacity
                style={styles.dossierConnectBtn}
                onPress={() => onConnectPeer(selectedPeer.id)}
                activeOpacity={0.7}
              >
                <Text style={styles.dossierConnectBtnText}>Connect</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.dossierChatBtn}
              onPress={() => onOpenChat(selectedPeer.nodeId || selectedPeer.id)}
              activeOpacity={0.75}
            >
              <Text style={styles.dossierChatBtnText}>Open Dedicated Chat ➔</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.emptyMapHint}>
          <Text style={styles.emptyMapHintText}>
            {displayPeers.length > 0
              ? `📍 ${displayPeers.length} node(s) plotted on vector map. Tap any node to chat.`
              : '🗺️ Map loaded with OpenFreeMap vector tiles. Download offline regions for 100% offline access.'}
          </Text>
        </View>
      )}

      {/* Offline Regions Manager Modal */}
      <Modal
        visible={showRegionsModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowRegionsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>OFFLINE MAP REGIONS</Text>
                <Text style={styles.modalSubtitle}>
                  Locally stored vector tiles • Zero cellular required
                </Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setShowRegionsModal(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
              {/* Section 1: Download Actions */}
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>DOWNLOAD NEW REGION</Text>

                <TouchableOpacity
                  style={[styles.downloadActionCard, isDownloading && styles.btnDisabled]}
                  onPress={handleDownloadCurrentViewport}
                  disabled={isDownloading}
                  activeOpacity={0.75}
                >
                  <View style={styles.downloadActionIcon}>
                    <Text style={styles.downloadActionGlyph}>📥</Text>
                  </View>
                  <View style={styles.downloadActionInfo}>
                    <Text style={styles.downloadActionTitle}>Download Current Viewport</Text>
                    <Text style={styles.downloadActionSub}>
                      Caches the current map screen for offline operational use
                    </Text>
                  </View>
                </TouchableOpacity>

                <View style={styles.presetRow}>
                  <TouchableOpacity
                    style={[styles.presetBtn, isDownloading && styles.btnDisabled]}
                    onPress={() => handleDownloadPresetSector(10, 'Local Hub Sector')}
                    disabled={isDownloading}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.presetBtnTitle}>Local Hub (10km)</Text>
                    <Text style={styles.presetBtnSub}>~5-10 MB</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.presetBtn, isDownloading && styles.btnDisabled]}
                    onPress={() => handleDownloadPresetSector(25, 'Disaster Crisis Sector')}
                    disabled={isDownloading}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.presetBtnTitle}>Crisis Sector (25km)</Text>
                    <Text style={styles.presetBtnSub}>~20-35 MB</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Section 2: Downloaded Packs List */}
              <View style={styles.modalSection}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.modalSectionTitle}>
                    DOWNLOADED PACKS ({offlinePacks.length})
                  </Text>
                  <TouchableOpacity onPress={handleClearCache} activeOpacity={0.7}>
                    <Text style={styles.clearCacheText}>Clear Temp Cache</Text>
                  </TouchableOpacity>
                </View>

                {offlinePacks.length === 0 ? (
                  <View style={styles.emptyPacksCard}>
                    <Text style={styles.emptyPacksTitle}>No Offline Regions Downloaded Yet</Text>
                    <Text style={styles.emptyPacksSub}>
                      Download your current area or operational crisis sector to ensure maps render without cellular data or power grid.
                    </Text>
                  </View>
                ) : (
                  offlinePacks.map((pack) => {
                    const status = packStatuses[pack.id];
                    const meta = (pack.metadata as any) || {};
                    const packName = meta.name || `Region-${pack.id.slice(0, 8)}`;
                    const sizeMb = status?.completedResourceSize
                      ? (status.completedResourceSize / (1024 * 1024)).toFixed(1)
                      : '0.0';

                    return (
                      <View key={pack.id} style={styles.packCard}>
                        <View style={styles.packInfo}>
                          <Text style={styles.packTitle}>{packName}</Text>
                          <Text style={styles.packMeta}>
                            Tiles: {status?.completedTileCount ?? 'N/A'} • {sizeMb} MB •{' '}
                            {status?.state ? status.state.toUpperCase() : 'STORED'}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.packDeleteBtn}
                          onPress={() => handleDeletePack(pack.id, packName)}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.packDeleteText}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#162032',
    marginHorizontal: 10,
    marginTop: 8,
    marginBottom: 20,
    padding: 12,
  },
  containerFullscreen: {
    marginHorizontal: 0,
    marginTop: 0,
    marginBottom: 0,
    borderRadius: 0,
    borderWidth: 0,
    flex: 1,
  },
  mapHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  titleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  offlineLiveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#10B981',
  },
  mapTitle: {
    fontSize: 11,
    fontWeight: '900',
    color: '#E2E8F0',
    letterSpacing: 0.8,
  },
  mapSubtitle: {
    fontSize: 9,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillBtn: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    borderWidth: 0.8,
    borderColor: '#1E293B',
  },
  pillBtnHighlight: {
    borderColor: '#0284C7',
    backgroundColor: '#082F49',
  },
  pillBtnText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#38BDF8',
  },
  mapWrapper: {
    width: '100%',
    height: 320,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#050811',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  mapWrapperFullscreen: {
    height: 520,
  },
  map: {
    flex: 1,
  },
  floatingControls: {
    position: 'absolute',
    right: 10,
    bottom: 12,
    gap: 6,
  },
  controlBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#090D1AE6',
    borderWidth: 1,
    borderColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnRecenter: {
    backgroundColor: '#0C2A44E6',
    borderColor: '#0284C7',
  },
  controlBtnText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#F8FAFC',
    lineHeight: 20,
  },
  recenterIcon: {
    fontSize: 16,
    color: '#38BDF8',
    fontWeight: '900',
  },
  userMarkerContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
  },
  userMarkerPulse: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#0284C740',
    borderWidth: 1.5,
    borderColor: '#38BDF8',
  },
  userMarkerCore: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  userMarkerText: {
    fontSize: 7.5,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  peerMarkerContainer: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
    elevation: 4,
  },
  peerMarkerConnected: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  peerMarkerDiscovered: {
    backgroundColor: '#0C2A44',
    borderColor: '#38BDF8',
  },
  peerMarkerSelected: {
    borderColor: '#F59E0B',
    borderWidth: 2.5,
  },
  peerMarkerText: {
    fontSize: 10,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  peerDistTag: {
    marginTop: 1,
  },
  peerDistTagText: {
    fontSize: 8,
    fontWeight: '700',
    color: '#94A3B8',
  },
  gpsOverlayBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#090D1AE8',
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderWidth: 1,
    gap: 7,
    zIndex: 10,
  },
  gpsOverlayLocked: {
    borderColor: '#10B981',
  },
  gpsOverlayAcquiring: {
    borderColor: '#F59E0B',
  },
  gpsOverlayDenied: {
    borderColor: '#EF4444',
  },
  gpsDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  gpsDotGreen: {
    backgroundColor: '#10B981',
  },
  gpsDotAmber: {
    backgroundColor: '#F59E0B',
  },
  gpsDotRed: {
    backgroundColor: '#EF4444',
  },
  gpsOverlayText: {
    fontSize: 9.5,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.4,
    flex: 1,
  },
  downloadRibbon: {
    position: 'absolute',
    top: 44,
    left: 10,
    right: 10,
    backgroundColor: '#090D1AF0',
    borderRadius: 8,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#0284C7',
    zIndex: 9,
  },
  downloadRibbonTextWrap: {
    flex: 1,
  },
  downloadRibbonTitle: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  downloadRibbonSub: {
    fontSize: 9.5,
    color: '#38BDF8',
    marginTop: 1,
  },
  dossierCard: {
    marginTop: 10,
    backgroundColor: '#0C1322',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  dossierHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dossierAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#0F2642',
    borderWidth: 1.5,
    borderColor: '#0284C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierAvatarText: {
    fontSize: 14,
    fontWeight: '900',
    color: '#38BDF8',
  },
  dossierInfo: {
    flex: 1,
  },
  dossierTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dossierName: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#F8FAFC',
    flex: 1,
  },
  statusPill: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  statusPillGreen: {
    backgroundColor: '#064E3B',
  },
  statusPillAmber: {
    backgroundColor: '#78350F',
  },
  statusPillText: {
    fontSize: 8.5,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  dossierMeta: {
    fontSize: 10.5,
    color: '#94A3B8',
    marginTop: 2,
    fontWeight: '600',
  },
  dossierActionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  dossierConnectBtn: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierConnectBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  dossierChatBtn: {
    flex: 2,
    backgroundColor: '#0284C7',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierChatBtnText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  emptyMapHint: {
    marginTop: 8,
    paddingHorizontal: 4,
  },
  emptyMapHintText: {
    fontSize: 10,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: '#000000B0',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#090D1A',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  modalTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: '#F8FAFC',
    letterSpacing: 0.6,
  },
  modalSubtitle: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1,
  },
  modalCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseText: {
    fontSize: 13,
    color: '#94A3B8',
    fontWeight: '700',
  },
  modalScroll: {
    maxHeight: 460,
  },
  modalSection: {
    marginBottom: 16,
  },
  modalSectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  clearCacheText: {
    fontSize: 9.5,
    fontWeight: '700',
    color: '#EF4444',
  },
  downloadActionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0C2A44',
    borderWidth: 1,
    borderColor: '#0284C7',
    borderRadius: 8,
    padding: 12,
    gap: 12,
    marginBottom: 8,
  },
  downloadActionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#082F49',
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadActionGlyph: {
    fontSize: 16,
  },
  downloadActionInfo: {
    flex: 1,
  },
  downloadActionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  downloadActionSub: {
    fontSize: 9.5,
    color: '#94A3B8',
    marginTop: 2,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
  },
  presetBtn: {
    flex: 1,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  presetBtnTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  presetBtnSub: {
    fontSize: 9,
    color: '#64748B',
    marginTop: 2,
  },
  packCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0C1322',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 6,
  },
  packInfo: {
    flex: 1,
  },
  packTitle: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  packMeta: {
    fontSize: 9.5,
    color: '#64748B',
    marginTop: 2,
  },
  packDeleteBtn: {
    backgroundColor: '#2D1515',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 0.8,
    borderColor: '#EF4444',
  },
  packDeleteText: {
    fontSize: 9.5,
    fontWeight: '700',
    color: '#EF4444',
  },
  emptyPacksCard: {
    backgroundColor: '#0C1322',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  emptyPacksTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#E2E8F0',
    marginBottom: 4,
  },
  emptyPacksSub: {
    fontSize: 9.5,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 14,
  },
  btnDisabled: {
    opacity: 0.5,
  },
});

