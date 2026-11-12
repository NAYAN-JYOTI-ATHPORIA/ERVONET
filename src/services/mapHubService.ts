export interface MapManifestResponse {
  ssid: string;
  ip: string;
  path: string;
  sizeBytes: number;
  sdReady: boolean;
  validPmTiles: boolean;
}

export interface MapHubDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  percentage: number;
  validPmTilesMagic: boolean;
}

/**
 * Fetches /manifest.json from the ESP32 SoftAP HTTP server (192.168.4.1).
 */
export async function probeRelayMapManifest(
  baseUrl: string = 'http://192.168.4.1'
): Promise<MapManifestResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/manifest.json`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Manifest HTTP ${res.status}`);
    }
    return (await res.json()) as MapManifestResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams /maps/region.pmtiles in HTTP 206 Partial Content byte-range chunks
 * directly from the ESP32 MicroSD HTTP server and validates PMTiles header + length.
 */
export async function downloadPmtilesFromRelay(params: {
  baseUrl?: string;
  chunkBytes?: number;
  onProgress?: (progress: MapHubDownloadProgress) => void;
}): Promise<{
  totalBytes: number;
  chunkCount: number;
  validPmTilesMagic: boolean;
}> {
  const baseUrl = params.baseUrl || 'http://192.168.4.1';
  const chunkSize = params.chunkBytes || 262144; // 256 KB HTTP 206 byte ranges
  const manifest = await probeRelayMapManifest(baseUrl);

  if (!manifest.sdReady || !manifest.sizeBytes || manifest.sizeBytes <= 0) {
    throw new Error('MicroSD /maps/region.pmtiles is not mounted on the ESP32 relay node.');
  }

  const totalBytes = manifest.sizeBytes;
  let offset = 0;
  let chunkCount = 0;
  let validPmTilesMagic = manifest.validPmTiles;

  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize - 1, totalBytes - 1);
    const res = await fetch(`${baseUrl}${manifest.path || '/maps/region.pmtiles'}`, {
      method: 'GET',
      headers: {
        Range: `bytes=${offset}-${end}`,
      },
    });

    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Unexpected HTTP status ${res.status} at offset ${offset}`);
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      throw new Error(`Zero-byte read from ESP32 Map Server at offset ${offset}`);
    }

    if (offset === 0 && buf.byteLength >= 7) {
      const header = new Uint8Array(buf.slice(0, 7));
      const sig = String.fromCharCode(...header);
      validPmTilesMagic = sig === 'PMTiles';
    }

    offset += buf.byteLength;
    chunkCount++;
    params.onProgress?.({
      receivedBytes: offset,
      totalBytes,
      percentage: Math.min(100, Math.round((offset / totalBytes) * 100)),
      validPmTilesMagic,
    });
  }

  return {
    totalBytes: offset,
    chunkCount,
    validPmTilesMagic,
  };
}

