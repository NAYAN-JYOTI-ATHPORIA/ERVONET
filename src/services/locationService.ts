import { PermissionsAndroid, Platform } from 'react-native';
import { bleBridge } from './nativeBleBridge';
import { storageService } from './storageService';

export interface GpsLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: number;
}

class LocationService {
  private lastPosition: GpsLocation | null = storageService.getLastKnownLocation();
  private isTracking: boolean = false;
  private startTrackingPromise: Promise<boolean> | null = null;
  private listeners: Set<(pos: GpsLocation) => void> = new Set();

  constructor() {
    // If native bridge is available, prime location immediately
    bleBridge.getDeviceLocation().then((loc) => {
      if (loc) {
        this.updatePosition(loc);
      }
    }).catch(() => {});

    this.startTracking().catch(() => {});
  }

  public updatePosition(pos: GpsLocation) {
    if (
      typeof pos.latitude === 'number' &&
      typeof pos.longitude === 'number' &&
      !isNaN(pos.latitude) &&
      !isNaN(pos.longitude) &&
      pos.latitude !== 0 &&
      pos.longitude !== 0
    ) {
      this.lastPosition = {
        latitude: pos.latitude,
        longitude: pos.longitude,
        accuracy: pos.accuracy ? Math.round(pos.accuracy) : undefined,
        timestamp: pos.timestamp || Date.now(),
      };
      storageService.saveLastKnownLocation(this.lastPosition);
      this.listeners.forEach((listener) => {
        try {
          listener(this.lastPosition!);
        } catch {
          // Isolate listener errors
        }
      });
    }
  }

  public addListener(listener: (pos: GpsLocation) => void): () => void {
    this.listeners.add(listener);
    if (this.lastPosition) {
      listener(this.lastPosition);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    try {
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

      return fineGranted || coarseGranted;
    } catch (e) {
      console.warn('Error requesting location permissions:', e);
      return false;
    }
  }

  public async startTracking(): Promise<boolean> {
    if (this.isTracking) return true;
    if (this.startTrackingPromise) return this.startTrackingPromise;

    this.startTrackingPromise = (async () => {
      try {
        const hasPermission = await this.requestPermissions();
        if (!hasPermission) return false;

        this.isTracking = true;

        // Start native Android continuous location provider (GPS + Network).
        // Deliberately avoids @maplibre/maplibre-react-native LocationManager/MLRNLocationModule
        // whose TurboModule emitOnUpdate callback can segfault during RN 0.87 Bridgeless teardown.
        try {
          await bleBridge.startLocationUpdates();
          const nativeLoc = await bleBridge.getDeviceLocation();
          if (nativeLoc) {
            this.updatePosition(nativeLoc);
          }
        } catch (e) {
          console.warn('Native location start error:', e);
        }

        return true;
      } finally {
        this.startTrackingPromise = null;
      }
    })();

    return this.startTrackingPromise;
  }

  public async getCurrentLocation(): Promise<GpsLocation | null> {
    if (!this.isTracking) {
      await this.startTracking();
    }

    // Query native Android LocationManager (checks GPS + Network + Passive cached fix)
    try {
      const nativeLoc = await bleBridge.getDeviceLocation();
      if (nativeLoc) {
        this.updatePosition(nativeLoc);
        return this.lastPosition;
      }
    } catch {
      // fallback
    }

    return this.lastPosition;
  }

  public getLastKnownLocation(): GpsLocation | null {
    return this.lastPosition;
  }
}

export const locationService = new LocationService();
