import { describe, it, expect } from 'vitest';
import { haversineMeters, checkGeofence } from './geofence.js';

describe('geofence', () => {
  it('measures haversine distance between two close points', () => {
    // ~111,320 m per degree of latitude at the equator; 0.001 deg lat ~= 111 m.
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 });
    expect(d).toBeGreaterThan(108);
    expect(d).toBeLessThan(115);
  });

  it('is zero for the same point', () => {
    expect(haversineMeters({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0);
  });

  it('passes when inside the office radius', () => {
    const office = { lat: 51.5, lng: -0.12, radiusMeters: 150 };
    // ~55 m north of the office.
    const r = checkGeofence({ lat: 51.5005, lng: -0.12 }, [office]);
    expect(r.ok).toBe(true);
    expect(r.distanceMeters).toBeLessThanOrEqual(150);
  });

  it('passes inside the buffer even when just outside the radius', () => {
    const office = { lat: 51.5, lng: -0.12, radiusMeters: 50, bufferMeters: 100 };
    // ~55 m away: outside the 50 m radius but inside radius+buffer = 150 m.
    const r = checkGeofence({ lat: 51.5005, lng: -0.12 }, [office]);
    expect(r.ok).toBe(true);
    expect(r.allowedMeters).toBe(150);
  });

  it('fails outside radius + buffer and reports the nearest office', () => {
    const office = { lat: 51.5, lng: -0.12, radiusMeters: 50, bufferMeters: 20 };
    const r = checkGeofence({ lat: 51.51, lng: -0.12 }, [office]); // ~1.1 km away
    expect(r.ok).toBe(false);
    expect(r.distanceMeters).toBeGreaterThan(70);
    expect(r.office).toBe(office);
  });

  it('passes when no offices are configured (geofencing off)', () => {
    expect(checkGeofence({ lat: 0, lng: 0 }, []).ok).toBe(true);
  });

  it('passes if inside ANY of several offices', () => {
    const offices = [
      { lat: 40.0, lng: -70.0, radiusMeters: 100 },
      { lat: 51.5, lng: -0.12, radiusMeters: 100 },
    ];
    expect(checkGeofence({ lat: 51.5004, lng: -0.12 }, offices).ok).toBe(true);
  });
});
