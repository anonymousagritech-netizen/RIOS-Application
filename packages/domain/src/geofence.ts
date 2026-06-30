/**
 * Geofence helpers for attendance punch validation. Pure and deterministic.
 *
 * A punch is allowed when the device location is within an office location's
 * radius plus a tolerance buffer (to absorb GPS jitter and a configurable
 * grace zone), measured by great-circle (haversine) distance.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface OfficeGeofence {
  lat: number;
  lng: number;
  radiusMeters: number;
  bufferMeters?: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GeofenceCheck {
  ok: boolean;
  distanceMeters: number;
  allowedMeters: number;
  office?: OfficeGeofence;
}

/**
 * Is `point` inside ANY of the given office geofences (radius + buffer)?
 * Returns the nearest office and the distance, so the UI can explain a miss.
 * With no offices configured, the check passes (geofencing not enforced).
 */
export function checkGeofence(point: GeoPoint, offices: OfficeGeofence[]): GeofenceCheck {
  if (!offices.length) {
    return { ok: true, distanceMeters: 0, allowedMeters: 0 };
  }
  let best: GeofenceCheck | null = null;
  for (const office of offices) {
    const distanceMeters = Math.round(haversineMeters(point, office));
    const allowedMeters = office.radiusMeters + (office.bufferMeters ?? 0);
    const check: GeofenceCheck = {
      ok: distanceMeters <= allowedMeters,
      distanceMeters,
      allowedMeters,
      office,
    };
    if (check.ok) return check;
    if (!best || distanceMeters < best.distanceMeters) best = check;
  }
  return best!;
}
