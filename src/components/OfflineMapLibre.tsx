import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  Share,
  TextInput,
  Platform,
} from 'react-native';
import {
  Map,
  Camera,
  Marker,
  OfflineManager,
  type CameraRef,
  type MapRef,
  type OfflinePack,
  type OfflinePackStatus,
  type LngLatBounds,
} from '@maplibre/maplibre-react-native';
import { PeerNode } from '../types/ble';
import { MapSectorPayload, MapServerStatus } from '../types/message';
import { estimateDistanceMeters } from '../utils/distance';
import { locationService } from '../services/locationService';
import { bleBridge } from '../services/nativeBleBridge';
import { bleService } from '../services/bleService';
import { downloadPmtilesFromRelay } from '../services/mapHubService';

interface OfflineMapLibreProps {
  peers: PeerNode[];
  focusedSector?: MapSectorPayload | null;
  onClearFocusedSector?: () => void;
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
  peers,
  focusedSector,
  onClearFocusedSector,
  onOpenChat,
  onConnectPeer,
}) => {
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);

  // Exact Live GPS Location State: initialize from cached fix if available
  const initialGps = locationService.getLastKnownLocation();
  const [userCoords, setUserCoords] = useState<[number, number] | null>(
    initialGps ? [initialGps.longitude, initialGps.latitude] : null
  );
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(
    initialGps?.accuracy || null
  );
  const [gpsStatus, setGpsStatus] = useState<'ACQUIRING' | 'LOCKED' | 'DENIED'>(
    initialGps ? 'LOCKED' : 'ACQUIRING'
  );
  const hasCenteredRef = useRef<boolean>(!!initialGps);

  // Fallback coordinate: broad regional reference only used before first GPS acquisition
  const [fallbackCenter] = useState<[number, number]>([78.9629, 20.5937]);
  const [currentZoom, setCurrentZoom] = useState<number>(initialGps ? 15 : 5);
  const [currentStyle, setCurrentStyle] = useState<StyleKey>('liberty');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Offline Regions state
  const [offlinePacks, setOfflinePacks] = useState<OfflinePack[]>([]);
  const [packStatuses, setPackStatuses] = useState<Record<string, OfflinePackStatus>>({});
  const [showRegionsModal, setShowRegionsModal] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);

  // Map Data Sharing & Import state
  const [activeFocusedSector, setActiveFocusedSector] = useState<MapSectorPayload | null>(focusedSector || null);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [importInputText, setImportInputText] = useState<string>('');
  const [showPeerShareModal, setShowPeerShareModal] = useState<boolean>(false);
  const [sectorToShare, setSectorToShare] = useState<{ name: string; bounds: LngLatBounds } | null>(null);

  // Selected peer on map
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [mapHubStatus, setMapHubStatus] = useState<MapServerStatus | null>(() =>
    bleService.getMapServerStatus()
  );

  useEffect(() => {
    const unsub = bleService.subscribe(() => {
      setMapHubStatus(bleService.getMapServerStatus());
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (focusedSector) {
      setActiveFocusedSector(focusedSector);
      const center = focusedSector.center || [
        (focusedSector.bounds[0] + focusedSector.bounds[2]) / 2,
        (focusedSector.bounds[1] + focusedSector.bounds[3]) / 2,
      ];
      cameraRef.current?.flyTo({
        center: center,
        zoom: focusedSector.minZoom || 14,
        duration: 900,
      });
    }
  }, [focusedSector]);

  // The active position: prioritize exact GPS
  const activePosition: [number, number] = userCoords || fallbackCenter;

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
    let isMounted = true;
    loadOfflinePacks();

    locationService.startTracking().then((started) => {
      if (isMounted && !started) {
        setGpsStatus('DENIED');
      }
    });

    // Listen to real-time high-accuracy location fixes from locationService (native Android GPS + Network)
    const unsubLocation = locationService.addListener((pos) => {
      if (!isMounted) return;
      const coords: [number, number] = [pos.longitude, pos.latitude];
      setUserCoords(coords);
      setGpsAccuracy(pos.accuracy || null);
      setGpsStatus('LOCKED');
      if (!hasCenteredRef.current) {
        hasCenteredRef.current = true;
        cameraRef.current?.flyTo({
          center: coords,
          zoom: 16,
          duration: 900,
        });
      }
    });

    // Also query high-accuracy native location provider immediately
    locationService.getCurrentLocation().then((loc) => {
      if (!isMounted || !loc) return;
      const coords: [number, number] = [loc.longitude, loc.latitude];
      setUserCoords(coords);
      setGpsAccuracy(loc.accuracy || null);
      setGpsStatus('LOCKED');
      if (!hasCenteredRef.current) {
        hasCenteredRef.current = true;
        cameraRef.current?.flyTo({
          center: coords,
          zoom: 16,
          duration: 900,
        });
      }
    });

    return () => {
      isMounted = false;
      unsubLocation();
    };
  }, []);

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
            bounds: bounds,
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

  const getCurrentViewportBounds = async (): Promise<LngLatBounds> => {
    if (mapRef.current) {
      return await mapRef.current.getBounds();
    }
    const delta = 0.05;
    return [
      activePosition[0] - delta,
      activePosition[1] - delta,
      activePosition[0] + delta,
      activePosition[1] + delta,
    ];
  };

  // Download current map viewport as an offline region
  const handleDownloadCurrentViewport = async () => {
    try {
      const bounds = await getCurrentViewportBounds();
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

  // 1. Share Map Sector via Android System Share Sheet (Nearby Share, Bluetooth file, messaging)
  const handleShareSectorToApp = async (name: string, bounds: LngLatBounds) => {
    try {
      const sectorPayload: MapSectorPayload = {
        type: 'MAP_SECTOR',
        name,
        bounds,
        minZoom: 12,
        maxZoom: 15,
        style: currentStyle,
        center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        timestamp: Date.now(),
      };

      await Share.share({
        title: `ERVONET Map: ${name}`,
        message: `[ERVONET OFFLINE MAP SECTOR]\nSector: ${name}\nBounds: [${bounds[0].toFixed(4)}, ${bounds[1].toFixed(4)}, ${bounds[2].toFixed(4)}, ${bounds[3].toFixed(4)}]\nPayload: ${JSON.stringify(sectorPayload)}`,
      });
    } catch (e: any) {
      Alert.alert('Share Notice', e?.message || 'Could not initiate share.');
    }
  };

  // 2. Share Current Viewport directly to app
  const handleShareCurrentViewportToApp = async () => {
    try {
      const bounds = await getCurrentViewportBounds();
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await handleShareSectorToApp(`Tactical Sector ${timestamp}`, bounds);
    } catch (e: any) {
      Alert.alert('Notice', e?.message || 'Could not calculate viewport.');
    }
  };

  // 3. Initiate BLE Mesh Radio Share: opens peer picker or sends to Everyone
  const handleInitiateBleShare = async (name: string, bounds: LngLatBounds) => {
    setSectorToShare({ name, bounds });
    setShowPeerShareModal(true);
  };

  // 4. Execute BLE Mesh Radio Share to selected recipient
  const handleExecuteBleShare = async (targetId: string, targetName: string) => {
    if (!sectorToShare) return;
    setShowPeerShareModal(false);

    try {
      const ok = await bleService.shareMapSector({
        targetId,
        name: sectorToShare.name,
        bounds: sectorToShare.bounds,
        minZoom: 12,
        maxZoom: 15,
        style: currentStyle,
      });

      if (ok) {
        Alert.alert(
          'Map Sector Dispatched',
          `Sector "${sectorToShare.name}" transmitted directly across the offline Bluetooth mesh to ${targetName}.`
        );
      } else {
        Alert.alert(
          'Queued in Outbox',
          `Direct mesh route to ${targetName} unavailable. Sector "${sectorToShare.name}" is queued in the ERVONET Outbox for opportunistic relay.`
        );
      }
    } catch (e: any) {
      Alert.alert('Radio Error', e?.message || 'Failed to transmit map sector.');
    } finally {
      setSectorToShare(null);
    }
  };

  // 5. Share Full Offline Vector Tile Database (.db SQLite file)
  const handleShareTileDatabase = async () => {
    try {
      await bleBridge.shareOfflineMapDatabase();
    } catch (e: any) {
      Alert.alert(
        'Database Export Notice',
        e?.message || 'No downloaded offline map packs found. Download a sector first.'
      );
    }
  };

  // 6. Import Map Sector (from Pasted JSON or Code)
  const handleImportMapSector = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      Alert.alert('Invalid Input', 'Please paste valid ERVONET map sector data or JSON.');
      return;
    }

    try {
      let jsonStr = trimmed;
      const jsonStart = trimmed.indexOf('{');
      const jsonEnd = trimmed.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        jsonStr = trimmed.slice(jsonStart, jsonEnd + 1);
      }

      const parsed = JSON.parse(jsonStr);
      if (parsed && Array.isArray(parsed.bounds) && parsed.bounds.length === 4) {
        const bounds: LngLatBounds = parsed.bounds;
        const name = parsed.name || 'Imported Tactical Sector';
        const center: [number, number] = parsed.center || [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];

        setShowImportModal(false);
        setImportInputText('');
        setShowRegionsModal(false);

        setActiveFocusedSector({
          type: 'MAP_SECTOR',
          name,
          bounds,
          minZoom: parsed.minZoom || 12,
          maxZoom: parsed.maxZoom || 15,
          style: parsed.style || currentStyle,
          center,
          timestamp: Date.now(),
        });

        cameraRef.current?.flyTo({
          center: center,
          zoom: parsed.minZoom || 14,
          duration: 900,
        });

        Alert.alert(
          'Map Sector Loaded',
          `"${name}" centered successfully.\n\nCoordinates:\n[${bounds[0].toFixed(3)}°, ${bounds[1].toFixed(3)}°] ➔ [${bounds[2].toFixed(3)}°, ${bounds[3].toFixed(3)}°]\n\nWould you like to cache this sector offline now?`,
          [
            { text: 'View Only', style: 'cancel' },
            {
              text: 'Download & Cache Offline',
              onPress: () => handleDownloadRegion(name, bounds, parsed.minZoom || 12, parsed.maxZoom || 15),
            },
          ]
        );
      } else {
        throw new Error('Invalid bounds format. Expected 4 coordinate array [west, south, east, north].');
      }
    } catch (e: any) {
      Alert.alert('Import Error', `Could not parse map data: ${e?.message || 'Invalid format'}`);
    }
  };

  // Zoom In / Zoom Out
  const handleZoom = (delta: number) => {
    const nextZoom = Math.min(18, Math.max(3, currentZoom + delta));
    setCurrentZoom(nextZoom);
    cameraRef.current?.zoomTo(nextZoom, { duration: 200 });
  };

  // Center on local node (YOU) with exact live GPS location
  const handleRecenter = async () => {
    if (userCoords) {
      cameraRef.current?.flyTo({
        center: userCoords,
        zoom: 16,
        duration: 500,
      });
    }

    // Always re-query locationService for freshest physical satellite coordinates
    locationService.getCurrentLocation().then((fresh) => {
      if (fresh) {
        const coords: [number, number] = [fresh.longitude, fresh.latitude];
        setUserCoords(coords);
        setGpsAccuracy(fresh.accuracy || null);
        setGpsStatus('LOCKED');
        cameraRef.current?.flyTo({
          center: coords,
          zoom: 16,
          duration: 500,
        });
      }
    }).catch(() => { });
  };

  // Derive geographic latitude/longitude for a peer based on exact GPS coordinates or BLE estimated distance
  const getPeerCoordinates = (peer: PeerNode): [number, number] | null => {
    // 1. If peer broadcasted exact physical GPS coordinates (via SOS or GPS beacon), use them!
    if (
      peer.lastKnownLocation &&
      typeof peer.lastKnownLocation.longitude === 'number' &&
      typeof peer.lastKnownLocation.latitude === 'number'
    ) {
      return [peer.lastKnownLocation.longitude, peer.lastKnownLocation.latitude];
    }

    // 2. Otherwise derive estimated coordinates based on BLE RSSI distance and stable bearing ONLY if our own GPS is locked
    if (userCoords) {
      const dist = peer.rssi ? estimateDistanceMeters(peer.rssi) : 15;
      const angle = deriveAngleFromId(peer.nodeId || peer.id);
      const [uLng, uLat] = userCoords;

      // Approximating meter offsets into latitude/longitude degrees
      // 1 deg latitude ~= 111,320m
      const deltaLat = (dist * Math.cos(angle)) / 111320;
      const deltaLng =
        (dist * Math.sin(angle)) / (111320 * Math.cos((uLat * Math.PI) / 180));

      return [uLng + deltaLng, uLat + deltaLat];
    }

    // 3. No coordinate anchor available yet
    return null;
  };

  // Peers already arrive deduplicated and self-filtered from bleService.getDeduplicatedPeers()
  const displayPeers = React.useMemo(
    () => peers.filter((p) => p.connectionState === 'CONNECTED' || p.connectionState === 'DISCOVERED'),
    [peers]
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
              STYLE: {currentStyle.toUpperCase()}
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
            style={[styles.pillBtn, isFullscreen && styles.pillBtnActive]}
            onPress={() => setIsFullscreen(!isFullscreen)}
            activeOpacity={0.7}
          >
            <Text style={styles.pillBtnText}>
              {isFullscreen ? 'EXIT FULL' : 'EXPAND'}
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
          onDidFinishLoadingStyle={() => {
            if (userCoords) {
              cameraRef.current?.flyTo({
                center: userCoords,
                zoom: 16,
                duration: 600,
              });
            }
          }}
        >
          <Camera
            ref={cameraRef}
            initialViewState={{
              center: userCoords || fallbackCenter,
              zoom: userCoords ? 15 : 5,
            }}
          />

          {/* High-Tech Tactical Beacon Marker for Local User (YOU) - driven safely by native locationService (avoids RN New Arch MLRNLocationModule EventEmitter crash) */}
          {userCoords && (
            <Marker lngLat={userCoords}>
              <View style={styles.userMarkerContainer}>
                <View style={styles.userMarkerPulse} />
                <View style={styles.userMarkerCore}>
                  <Text style={styles.userMarkerText}>YOU</Text>
                </View>
              </View>
            </Marker>
          )}

          {/* Peer Nodes Plotted on the Map */}
          {displayPeers.map((peer) => {
            const peerCoords = getPeerCoordinates(peer);
            if (!peerCoords) return null;

            const isConnected = peer.connectionState === 'CONNECTED';
            const dist = peer.rssi ? estimateDistanceMeters(peer.rssi) : 10;
            const isSelected =
              selectedPeerId === peer.id || selectedPeerId === peer.nodeId;
            const peerInitial = (peer.name?.[0] || peer.nodeId?.[0] || 'U').toUpperCase();
            const isSos = !!peer.hasActiveSos;
            const hasExactGps = !!peer.lastKnownLocation;

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
                    isSos && styles.peerMarkerSos,
                    isSelected && styles.peerMarkerSelected,
                  ]}
                  onPress={() => setSelectedPeerId(peer.nodeId || peer.id)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.peerMarkerText}>{isSos ? 'SOS' : peerInitial}</Text>
                  <View style={[styles.peerDistTag, isSos && styles.peerDistTagSos]}>
                    <Text style={[styles.peerDistTagText, isSos && styles.peerDistTagTextSos]}>
                      {isSos ? 'SOS' : hasExactGps ? `GPS ~${dist}m` : `~${dist}m`}
                    </Text>
                  </View>
                </TouchableOpacity>
              </Marker>
            );
          })}

          {/* Active Focused Tactical Sector Center Pin */}
          {activeFocusedSector && (
            <Marker
              lngLat={
                activeFocusedSector.center || [
                  (activeFocusedSector.bounds[0] + activeFocusedSector.bounds[2]) / 2,
                  (activeFocusedSector.bounds[1] + activeFocusedSector.bounds[3]) / 2,
                ]
              }
            >
              <View style={styles.sectorCenterMarker}>
                <View style={styles.sectorCenterPulse} />
                <View style={styles.sectorCenterDot} />
                <View style={styles.sectorCenterLabel}>
                  <Text style={styles.sectorCenterLabelText}>
                    {activeFocusedSector.name}
                  </Text>
                </View>
              </View>
            </Marker>
          )}
        </Map>

        {/* Compact Live GPS Status Badge */}
        <TouchableOpacity
          style={[
            styles.gpsOverlayBadge,
            gpsStatus === 'LOCKED'
              ? styles.gpsOverlayLocked
              : gpsStatus === 'DENIED'
                ? styles.gpsOverlayDenied
                : styles.gpsOverlayAcquiring,
          ]}
          onPress={handleRecenter}
          activeOpacity={0.75}
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
              ? `${userCoords[1].toFixed(4)}°N, ${userCoords[0].toFixed(4)}°E (±${gpsAccuracy ?? 5}m)`
              : gpsStatus === 'DENIED'
                ? 'GPS OFF • TAP TO FIX'
                : 'ACQUIRING GPS LOCK...'}
          </Text>
        </TouchableOpacity>

        {/* Active Focused Sector Banner */}
        {activeFocusedSector && (
          <View style={styles.focusedSectorRibbon}>
            <View style={styles.focusedSectorInfo}>
              <Text style={styles.focusedSectorTitle} numberOfLines={1}>
                SECTOR: {activeFocusedSector.name.toUpperCase()}
              </Text>
              <Text style={styles.focusedSectorCoords}>
                [{activeFocusedSector.bounds[0].toFixed(3)}°, {activeFocusedSector.bounds[1].toFixed(3)}°] ➔ [{activeFocusedSector.bounds[2].toFixed(3)}°, {activeFocusedSector.bounds[3].toFixed(3)}°]
              </Text>
            </View>
            <View style={styles.focusedSectorActions}>
              <TouchableOpacity
                style={styles.focusedSectorDlBtn}
                onPress={() => {
                  handleDownloadRegion(
                    activeFocusedSector.name,
                    activeFocusedSector.bounds,
                    activeFocusedSector.minZoom || 12,
                    activeFocusedSector.maxZoom || 15
                  );
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.focusedSectorDlText}>CACHE</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.focusedSectorClearBtn}
                onPress={() => {
                  setActiveFocusedSector(null);
                  onClearFocusedSector?.();
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.focusedSectorClearText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Floating Controls: Zoom In / Zoom Out / Recenter */}
        <View style={styles.floatingControls}>
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={() => handleZoom(1)}
            activeOpacity={0.7}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Text style={styles.controlBtnText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={() => handleZoom(-1)}
            activeOpacity={0.7}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Text style={styles.controlBtnText}>−</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.controlBtn, styles.controlBtnRecenter]}
            onPress={handleRecenter}
            activeOpacity={0.7}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
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
                {selectedPeer.lastKnownLocation
                  ? ` • GPS: ${selectedPeer.lastKnownLocation.latitude.toFixed(4)}, ${selectedPeer.lastKnownLocation.longitude.toFixed(4)}`
                  : ''}
              </Text>
            </View>
          </View>

          {selectedPeer.hasActiveSos && (
            <View style={styles.dossierSosBadge}>
              <Text style={styles.dossierSosText}>[CRITICAL SOS BEACON BROADCASTED]</Text>
            </View>
          )}

          <View style={styles.dossierActionRow}>
            {selectedPeer.lastKnownLocation && (
              <TouchableOpacity
                style={styles.dossierFocusBtn}
                onPress={() => {
                  cameraRef.current?.flyTo({
                    center: [
                      selectedPeer.lastKnownLocation!.longitude,
                      selectedPeer.lastKnownLocation!.latitude,
                    ],
                    zoom: 16,
                    duration: 600,
                  });
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.dossierFocusBtnText}>Focus Node</Text>
              </TouchableOpacity>
            )}
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
              <Text style={styles.dossierChatBtnText}>Open Chat ➔</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.emptyMapHint}>
          <Text style={styles.emptyMapHintText}>
            {displayPeers.length > 0
              ? `${displayPeers.length} active node(s) plotted on tactical vector map. Tap node to select.`
              : 'Tactical vector map active (OpenFreeMap). Download offline sectors for disconnected operation.'}
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
              {/* Section 1: Peer-to-Peer Map Sharing & Transfer */}
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>PEER-TO-PEER MAP SHARING & TRANSFER</Text>

                {/* 1. Share Current Viewport via BLE Radio Mesh */}
                <TouchableOpacity
                  style={styles.shareActionCardMesh}
                  onPress={async () => {
                    const bounds = await getCurrentViewportBounds();
                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    handleInitiateBleShare(`Tactical Sector ${timestamp}`, bounds);
                  }}
                  activeOpacity={0.75}
                >
                  <View style={styles.shareActionIconMesh}>
                    <Text style={styles.shareActionGlyph}>[RADIO]</Text>
                  </View>
                  <View style={styles.shareActionInfo}>
                    <Text style={styles.shareActionTitle}>Share Viewport via BLE Mesh</Text>
                    <Text style={styles.shareActionSub}>
                      Broadcasts or directs active sector coordinates over zero-internet Bluetooth radio mesh
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* 2-column row: Share to App & Export Full DB */}
                <View style={styles.shareGridRow}>
                  <TouchableOpacity
                    style={styles.shareGridBtn}
                    onPress={handleShareCurrentViewportToApp}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.shareGridBtnTitle}>Share to App</Text>
                    <Text style={styles.shareGridBtnSub}>Quick Share / Nearby</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.shareGridBtn}
                    onPress={handleShareTileDatabase}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.shareGridBtnTitle}>Export Tile DB (.db)</Text>
                    <Text style={styles.shareGridBtnSub}>Vector cache export</Text>
                  </TouchableOpacity>
                </View>

                {/* 3. Import Map Sector */}
                <TouchableOpacity
                  style={styles.shareActionCardImport}
                  onPress={() => setShowImportModal(true)}
                  activeOpacity={0.75}
                >
                  <View style={styles.shareActionIconImport}>
                    <Text style={styles.shareActionGlyph}>[IMPORT]</Text>
                  </View>
                  <View style={styles.shareActionInfo}>
                    <Text style={styles.shareActionTitle}>Import Map Sector Data</Text>
                    <Text style={styles.shareActionSub}>
                      Paste tactical sector coordinates or JSON payload received from peer
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>

              {/* Section 2: Download Actions */}
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>DOWNLOAD NEW REGION</Text>

                <TouchableOpacity
                  style={[styles.downloadActionCard, isDownloading && styles.btnDisabled]}
                  onPress={handleDownloadCurrentViewport}
                  disabled={isDownloading}
                  activeOpacity={0.75}
                >
                  <View style={styles.downloadActionIcon}>
                    <Text style={styles.downloadActionGlyph}>[DL]</Text>
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

                <View style={styles.relayMapHubBox}>
                  <Text style={styles.relayMapHubTitle}>
                    ESP32 RELAY PMTiles MAP HUB (100% OFFLINE)
                  </Text>
                  <Text style={styles.relayMapHubSub}>
                    {mapHubStatus?.active
                      ? `SoftAP ACTIVE: ${mapHubStatus.ssid} (${mapHubStatus.ip}, Ch ${mapHubStatus.channel}) • SD ${(mapHubStatus.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
                      : 'Keep SoftAP OFF during normal mesh routing; wake via BLE only when downloading /maps/region.pmtiles.'}
                  </Text>
                  <View style={styles.relayMapHubBtnRow}>
                    <TouchableOpacity
                      style={styles.relayHubWakeBtn}
                      onPress={async () => {
                        const sent = await bleService.requestRelayMapServer(
                          mapHubStatus?.active ? 'STOP' : 'START'
                        );
                        if (!sent) {
                          Alert.alert(
                            'No ESP32 Relay Connected',
                            'Connect to a nearby ESP32 Relay Node over BLE first, or long-press the ESP32 GPIO 4 button for 2.5s.'
                          );
                        }
                      }}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.relayHubBtnText}>
                        {mapHubStatus?.active ? 'STOP MAP AP' : 'WAKE ESP32 AP'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.relayHubDownloadBtn, isDownloading && styles.btnDisabled]}
                      disabled={isDownloading}
                      onPress={async () => {
                        try {
                          setIsDownloading(true);
                          setDownloadProgress({
                            regionName: 'ESP32 SD PMTiles',
                            percentage: 0,
                            tiles: 0,
                            sizeBytes: 0,
                            statusText: 'Connecting to http://192.168.4.1 ...',
                          });
                          const res = await downloadPmtilesFromRelay({
                            baseUrl: 'http://192.168.4.1',
                            onProgress: (p) => {
                              setDownloadProgress({
                                regionName: 'ESP32 SD PMTiles',
                                percentage: p.percentage,
                                tiles: Math.ceil(p.receivedBytes / 262144),
                                sizeBytes: p.receivedBytes,
                                statusText: `Streaming range chunks (${p.percentage}%)`,
                              });
                            },
                          });
                          Alert.alert(
                            'PMTiles Verified',
                            `Downloaded ${(res.totalBytes / (1024 * 1024)).toFixed(2)} MB in ${res.chunkCount} HTTP 206 chunks (Header: ${res.validPmTilesMagic ? 'Valid PMTiles' : 'Unverified'}). Re-connect BLE & tap STOP MAP AP to save battery.`
                          );
                        } catch (err: any) {
                          Alert.alert(
                            'Map Hub Unreachable',
                            `${err?.message || err}\n\nJoin phone Wi-Fi "${mapHubStatus?.ssid || 'ERVONET-MAP-HUB'}" (pass: ervonet2026) first after waking the ESP32 SoftAP.`
                          );
                        } finally {
                          setIsDownloading(false);
                          setDownloadProgress(null);
                        }
                      }}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.relayHubBtnText}>PULL PMTiles</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>

              {/* Section 3: Downloaded Packs List */}
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
                        <View style={styles.packActionsRow}>
                          <TouchableOpacity
                            style={styles.packShareBtn}
                            onPress={() => {
                              const bounds = meta.bounds || [
                                activePosition[0] - 0.05,
                                activePosition[1] - 0.05,
                                activePosition[0] + 0.05,
                                activePosition[1] + 0.05,
                              ];
                              handleInitiateBleShare(packName, bounds);
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.packShareText}>RADIO</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.packExportBtn}
                            onPress={() => {
                              const bounds = meta.bounds || [
                                activePosition[0] - 0.05,
                                activePosition[1] - 0.05,
                                activePosition[0] + 0.05,
                                activePosition[1] + 0.05,
                              ];
                              handleShareSectorToApp(packName, bounds);
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.packExportText}>SHARE</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.packDeleteBtn}
                            onPress={() => handleDeletePack(pack.id, packName)}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.packDeleteText}>DEL</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* BLE Mesh Peer Share Modal */}
      <Modal
        visible={showPeerShareModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {
          setShowPeerShareModal(false);
          setSectorToShare(null);
        }}
      >
        <View style={styles.modalOverlayCenter}>
          <View style={styles.shareModalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>BLE MESH RADIO SHARE</Text>
                <Text style={styles.modalSubtitle}>
                  Transmit "{sectorToShare?.name}" over offline mesh
                </Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => {
                  setShowPeerShareModal(false);
                  setSectorToShare(null);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.shareModalSectionHeader}>SELECT RECIPIENT NODE</Text>

            <TouchableOpacity
              style={styles.shareTargetItem}
              onPress={() => handleExecuteBleShare('ALL', 'Everyone')}
              activeOpacity={0.75}
            >
              <View style={styles.shareTargetIconAll}>
                <Text style={styles.shareTargetIconText}>[ALL]</Text>
              </View>
              <View style={styles.shareTargetInfo}>
                <Text style={styles.shareTargetTitle}>Broadcast to Everyone</Text>
                <Text style={styles.shareTargetSub}>
                  Flood sector definition across all mesh nodes in range
                </Text>
              </View>
            </TouchableOpacity>

            <ScrollView style={styles.peerListScroll}>
              {displayPeers.filter((p) => p.connectionState === 'CONNECTED').length === 0 ? (
                <View style={styles.noConnectedPeersBox}>
                  <Text style={styles.noConnectedPeersText}>
                    No directly connected peers in range. Broadcast or opportunistic relay will be used.
                  </Text>
                </View>
              ) : (
                displayPeers
                  .filter((p) => p.connectionState === 'CONNECTED')
                  .map((peer) => (
                    <TouchableOpacity
                      key={peer.id}
                      style={styles.shareTargetItem}
                      onPress={() =>
                        handleExecuteBleShare(
                          peer.nodeId || peer.id,
                          peer.name || peer.nodeId
                        )
                      }
                      activeOpacity={0.75}
                    >
                      <View style={styles.shareTargetIconPeer}>
                        <Text style={styles.shareTargetIconText}>
                          {(peer.name?.[0] || peer.nodeId?.[0] || 'U').toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.shareTargetInfo}>
                        <Text style={styles.shareTargetTitle}>
                          {peer.name || peer.nodeId}
                        </Text>
                        <Text style={styles.shareTargetSub}>
                          Connected • RSSI {peer.rssi || -70} dBm
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))
              )}
            </ScrollView>

            <TouchableOpacity
              style={styles.modalCancelBtn}
              onPress={() => {
                setShowPeerShareModal(false);
                setSectorToShare(null);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.modalCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Import Map Sector Modal */}
      <Modal
        visible={showImportModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {
          setShowImportModal(false);
          setImportInputText('');
        }}
      >
        <View style={styles.modalOverlayCenter}>
          <View style={styles.shareModalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>IMPORT MAP SECTOR</Text>
                <Text style={styles.modalSubtitle}>
                  Paste ERVONET sector JSON or payload from another app
                </Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => {
                  setShowImportModal(false);
                  setImportInputText('');
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.importInput}
              multiline={true}
              numberOfLines={5}
              placeholder="Paste ERVONET map sector JSON or coordinate text here..."
              placeholderTextColor="#64748B"
              value={importInputText}
              onChangeText={setImportInputText}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.importActionsRow}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => {
                  setShowImportModal(false);
                  setImportInputText('');
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.importSubmitBtn}
                onPress={() => handleImportMapSector(importInputText)}
                activeOpacity={0.75}
              >
                <Text style={styles.importSubmitBtnText}>Load & Center ➔</Text>
              </TouchableOpacity>
            </View>
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
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#334155',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillBtnHighlight: {
    borderColor: '#0284C7',
    backgroundColor: '#0C2A44',
  },
  pillBtnActive: {
    borderColor: '#38BDF8',
    backgroundColor: '#1E293B',
  },
  pillBtnText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.3,
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
    right: 12,
    bottom: 14,
    gap: 8,
    zIndex: 10,
  },
  controlBtn: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#0F172AFA',
    borderWidth: 1.2,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.45,
    shadowRadius: 4,
    elevation: 6,
  },
  controlBtnRecenter: {
    backgroundColor: '#0284C7',
    borderColor: '#38BDF8',
  },
  controlBtnText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#F8FAFC',
    lineHeight: 24,
  },
  recenterIcon: {
    fontSize: 20,
    color: '#FFFFFF',
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
  peerMarkerSos: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
    borderWidth: 2,
    elevation: 6,
  },
  peerDistTagSos: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  peerDistTagTextSos: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  gpsOverlayBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    maxWidth: '78%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#090D1AEE',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1.2,
    gap: 6,
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
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
    width: 8,
    height: 8,
    borderRadius: 4,
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
    fontSize: 10,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.3,
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
  dossierSosBadge: {
    backgroundColor: '#7F1D1D40',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginTop: 6,
  },
  dossierSosText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FCA5A5',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  dossierFocusBtn: {
    flex: 1.2,
    backgroundColor: '#0C2A44',
    borderColor: '#0284C7',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dossierFocusBtnText: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#38BDF8',
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
  focusedSectorRibbon: {
    position: 'absolute',
    top: 48,
    left: 10,
    right: 10,
    backgroundColor: '#0A1E38F0',
    borderRadius: 8,
    borderWidth: 1.2,
    borderColor: '#0284C7',
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  focusedSectorInfo: {
    flex: 1,
    marginRight: 8,
  },
  focusedSectorTitle: {
    fontSize: 10.5,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 0.4,
  },
  focusedSectorCoords: {
    fontSize: 9,
    color: '#94A3B8',
    marginTop: 1,
  },
  focusedSectorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  focusedSectorDlBtn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  focusedSectorDlText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  focusedSectorClearBtn: {
    backgroundColor: '#1E293B',
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusedSectorClearText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94A3B8',
  },
  sectorCenterMarker: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectorCenterPulse: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#0284C733',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  sectorCenterDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#38BDF8',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  sectorCenterLabel: {
    backgroundColor: '#090D1AF0',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    marginTop: 4,
    borderWidth: 0.8,
    borderColor: '#0284C7',
  },
  sectorCenterLabelText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#38BDF8',
  },
  shareActionCardMesh: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#08253D',
    borderWidth: 1.2,
    borderColor: '#0284C7',
    borderRadius: 8,
    padding: 10,
    gap: 10,
    marginBottom: 8,
  },
  shareActionIconMesh: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#0C4A6E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareActionCardImport: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0B1B2B',
    borderWidth: 1,
    borderColor: '#1E3A5F',
    borderRadius: 8,
    padding: 10,
    gap: 10,
    marginTop: 8,
  },
  shareActionIconImport: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareActionGlyph: {
    fontSize: 9,
    fontWeight: '900',
    color: '#38BDF8',
  },
  shareActionInfo: {
    flex: 1,
  },
  shareActionTitle: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  shareActionSub: {
    fontSize: 9,
    color: '#94A3B8',
    marginTop: 1,
    lineHeight: 12,
  },
  shareGridRow: {
    flexDirection: 'row',
    gap: 8,
  },
  shareGridBtn: {
    flex: 1,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  shareGridBtnTitle: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  shareGridBtnSub: {
    fontSize: 8.5,
    color: '#64748B',
    marginTop: 2,
  },
  packActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  packShareBtn: {
    backgroundColor: '#08253D',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 0.8,
    borderColor: '#0284C7',
  },
  packShareText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#38BDF8',
  },
  packExportBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 0.8,
    borderColor: '#475569',
  },
  packExportText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  modalOverlayCenter: {
    flex: 1,
    backgroundColor: '#000000C8',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  shareModalContent: {
    backgroundColor: '#090D1A',
    borderRadius: 14,
    padding: 16,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1.2,
    borderColor: '#1E293B',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 8,
  },
  shareModalSectionHeader: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  shareTargetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0C1322',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
    gap: 10,
  },
  shareTargetIconAll: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#082F49',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#0284C7',
  },
  shareTargetIconPeer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#064E3B',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  shareTargetIconText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  shareTargetInfo: {
    flex: 1,
  },
  shareTargetTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  shareTargetSub: {
    fontSize: 9.5,
    color: '#64748B',
    marginTop: 1,
  },
  peerListScroll: {
    maxHeight: 180,
    marginVertical: 4,
  },
  noConnectedPeersBox: {
    backgroundColor: '#0F172A',
    padding: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginVertical: 4,
  },
  noConnectedPeersText: {
    fontSize: 9.5,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 14,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  modalCancelBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
  },
  importInput: {
    backgroundColor: '#070C18',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
    color: '#F8FAFC',
    fontSize: 11,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    padding: 10,
    textAlignVertical: 'top',
    minHeight: 100,
    marginBottom: 10,
  },
  importActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  importSubmitBtn: {
    flex: 1,
    backgroundColor: '#0284C7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  importSubmitBtnText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  relayMapHubBox: {
    marginTop: 10,
    backgroundColor: '#0C172A',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#0369A1',
  },
  relayMapHubTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: '#38BDF8',
    letterSpacing: 0.5,
  },
  relayMapHubSub: {
    fontSize: 9.5,
    color: '#94A3B8',
    marginTop: 4,
    lineHeight: 13,
  },
  relayMapHubBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  relayHubWakeBtn: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  relayHubDownloadBtn: {
    flex: 1,
    backgroundColor: '#0284C7',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  relayHubBtnText: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#F8FAFC',
  },
});

