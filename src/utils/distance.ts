/**
 * Calculates estimated distance in meters from BLE RSSI using the Log-Distance Path Loss Model.
 * In industrial environments (concrete, digester tanks, metal walkways), path loss exponent (n) is ~2.4 - 3.0.
 *
 * Formula: d = 10 ^ ((MeasuredPower - RSSI) / (10 * n))
 */
export function estimateDistanceMeters(
  rssi: number,
  txPower: number = -59,
  pathLossExponent: number = 2.4
): number {
  if (rssi >= 0 || rssi < -110) {
    return 0;
  }

  const ratio = (txPower - rssi) / (10 * pathLossExponent);
  const distance = Math.pow(10, ratio);
  // Round to 1 decimal place and clamp between 0.3m and 50m
  return Math.min(50, Math.max(0.3, Math.round(distance * 10) / 10));
}

/**
 * Categorizes RSSI strength into signal bars and human-readable qualitative levels.
 */
export function getSignalQuality(rssi: number): {
  level: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  bars: number; // 1 to 4
  color: string;
} {
  if (rssi >= -60) {
    return { level: 'EXCELLENT', bars: 4, color: '#10B981' }; // Green
  } else if (rssi >= -75) {
    return { level: 'GOOD', bars: 3, color: '#38BDF8' }; // Cyan
  } else if (rssi >= -85) {
    return { level: 'FAIR', bars: 2, color: '#F59E0B' }; // Amber
  } else {
    return { level: 'POOR', bars: 1, color: '#EF4444' }; // Red
  }
}

