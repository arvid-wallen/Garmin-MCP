import { Encoder, Profile } from '@garmin/fitsdk';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { analyzeFit, extractActivityFile, paceMinPerKm } from '../src/garmin/fit.js';

const MESG = Profile.MesgNum as unknown as Record<'FILE_ID' | 'EVENT' | 'RECORD' | 'LAP' | 'TIME_IN_ZONE' | 'SESSION' | 'ACTIVITY', number>;
const START = new Date('2026-11-01T07:00:00Z');
const DURATION = 1800; // 30 min

/** A synthetic 30-minute run: speed 3.33 m/s (5:00/km), HR ramps 120->170, power 250W with a 300W 5-min block. */
export function buildRunFit(withTimeInZone = true, sport = 'running'): Uint8Array {
  const e = new Encoder();
  const write = (num: number, mesg: Record<string, unknown>) => e.onMesg(num, mesg as never);
  write(MESG.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: START });
  write(MESG.EVENT, { timestamp: START, event: 'timer', eventType: 'start' });
  for (let t = 0; t <= DURATION; t++) {
    write(MESG.RECORD, {
      timestamp: new Date(START.getTime() + t * 1000),
      heartRate: Math.round(120 + (50 * t) / DURATION),
      distance: t * 3.3333,
      enhancedSpeed: 3.3333,
      power: t >= 600 && t < 900 ? 300 : 250,
      cadence: 88,
      enhancedAltitude: 20 + (t % 100) / 10,
      positionLat: Math.round((59.33 / 180) * 2 ** 31),
      positionLong: Math.round((18.06 / 180) * 2 ** 31),
    });
  }
  const end = new Date(START.getTime() + DURATION * 1000);
  for (let lap = 0; lap < 3; lap++) {
    write(MESG.LAP, {
      timestamp: new Date(START.getTime() + (lap + 1) * 600_000),
      startTime: new Date(START.getTime() + lap * 600_000),
      totalElapsedTime: 600,
      totalTimerTime: 600,
      totalDistance: 2000,
      avgSpeed: 3.3333,
      avgHeartRate: 130 + lap * 15,
      maxHeartRate: 140 + lap * 15,
      avgPower: 260,
    });
  }
  if (withTimeInZone) {
    write(MESG.TIME_IN_ZONE, {
      timestamp: end,
      referenceMesg: 'session',
      referenceIndex: 0,
      timeInHrZone: [0, 300, 600, 600, 300, 0],
      hrZoneHighBoundary: [130, 145, 158, 170, 190],
    });
  }
  write(MESG.SESSION, {
    timestamp: end,
    startTime: START,
    sport,
    subSport: 'generic',
    totalElapsedTime: DURATION,
    totalTimerTime: DURATION,
    totalDistance: 6000,
    avgSpeed: 3.3333,
    avgHeartRate: 145,
    maxHeartRate: 170,
    avgPower: 258,
    firstLapIndex: 0,
    numLaps: 3,
  });
  write(MESG.ACTIVITY, { timestamp: end, numSessions: 1, type: 'manual', event: 'activity', eventType: 'stop' });
  return e.close();
}

describe('FIT analysis', () => {
  it('extracts the FIT file from the download ZIP', () => {
    const fit = buildRunFit();
    const zip = zipSync({ '123_ACTIVITY.fit': fit });
    const file = extractActivityFile(zip);
    expect(file.kind).toBe('fit');
    expect(file.name).toBe('123_ACTIVITY.fit');
    expect(file.bytes.length).toBe(fit.length);
    expect(extractActivityFile(fit).kind).toBe('fit');
  });

  it('summarizes sessions, laps, zones, best efforts and a downsampled series', () => {
    const result = analyzeFit(buildRunFit(), { maxPoints: 60 });
    expect(result.sessions[0]).toMatchObject({ sport: 'running', totalDistance: 6000 });
    expect(result.sessions[0]!.avg_pace_min_per_km).toBe('5:00');
    expect(result.laps).toHaveLength(3);
    expect(result.laps![0]).toMatchObject({ lap: 1, pace_min_per_km: '5:00' });
    expect(result.hr_zones?.source).toContain('device');
    expect(result.records).toMatchObject({ count: 1801, has_gps: true, has_power: true, has_heart_rate: true });

    const power = result.best_efforts.power_w!;
    expect(power.find((p) => p.window_s === 300)!.value).toBe(300);
    expect(power.find((p) => p.window_s === 1200)!.value).toBeGreaterThan(250);
    const k1 = result.best_efforts.fastest_distances.find((d) => d.distance_m === 1000)!;
    expect(k1.seconds).toBeCloseTo(300, 0);
    expect(k1.pace_min_per_km).toBe('5:00');

    const ts = result.timeseries!;
    expect(ts.rows.length).toBeLessThanOrEqual(60);
    expect(ts.columns).toContain('heart_rate');
    expect(ts.columns).not.toContain('lat');
  });

  it('computes zones from records when the file has none, and includes GPS on request', () => {
    const result = analyzeFit(buildRunFit(false), {
      includeGps: true,
      hrZones: { floors: [100, 130, 145, 160, 175], max: 190, source: 'test zones' },
    });
    expect(result.hr_zones?.source).toContain('test zones');
    const zones = result.hr_zones!.zones as Array<{ zone: number; seconds: number }>;
    expect(zones.reduce((a, z) => a + z.seconds, 0)).toBeGreaterThan(1700);
    expect(result.timeseries!.columns).toContain('lat');
    const latIndex = result.timeseries!.columns.indexOf('lat');
    expect(result.timeseries!.rows[0]![latIndex]).toBeCloseTo(59.33, 3);
  });

  it('formats pace', () => {
    expect(paceMinPerKm(1000 / 299.6)).toBe('5:00');
    expect(paceMinPerKm(0)).toBeUndefined();
  });
});

describe('FIT analysis units', () => {
  it('reports pace for running and km/h for cycling', () => {
    const run = analyzeFit(buildRunFit());
    expect(run.sessions[0]!.avg_pace_min_per_km).toBe('5:00');
    expect(run.sessions[0]!.avg_speed_kmh).toBeUndefined();

    const ride = analyzeFit(buildRunFit(true, 'cycling'));
    expect(ride.sessions[0]!.avg_speed_kmh).toBe(12);
    expect(ride.sessions[0]!.avg_pace_min_per_km).toBeUndefined();
    expect(ride.laps![0]).toMatchObject({ speed_kmh: 12 });
    expect(ride.best_efforts.fastest_distances[0]).toHaveProperty('speed_kmh');
  });
});
