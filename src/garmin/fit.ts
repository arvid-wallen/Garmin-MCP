import { Decoder, Stream } from '@garmin/fitsdk';
import { unzipSync } from 'fflate';

/**
 * Activity file analysis. The Personal API has no per-second activity
 * endpoint; the only source of time series (HR, pace, power, GPS, running
 * dynamics) is the original file from the download service, which arrives as
 * a ZIP. This module unpacks it, decodes FIT with Garmin's official SDK and
 * reduces it to something a language model can read.
 */

type Msg = Record<string, unknown>;

export interface ExtractedFile {
  name: string;
  kind: 'fit' | 'gpx' | 'tcx' | 'other';
  bytes: Uint8Array;
}

function kindOf(name: string): ExtractedFile['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.fit')) return 'fit';
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.tcx')) return 'tcx';
  return 'other';
}

/** Unpack the download-service ZIP. Non-ZIP payloads are returned as-is. */
export function extractActivityFile(payload: Uint8Array, fallbackName = 'activity'): ExtractedFile {
  const isZip = payload[0] === 0x50 && payload[1] === 0x4b;
  if (!isZip) {
    const isFit = payload.length > 12 && String.fromCharCode(...payload.subarray(8, 12)) === '.FIT';
    return { name: isFit ? `${fallbackName}.fit` : fallbackName, kind: isFit ? 'fit' : 'other', bytes: payload };
  }
  const files = unzipSync(payload);
  const entries = Object.entries(files).filter(([name, bytes]) => !name.endsWith('/') && bytes.length > 0);
  if (entries.length === 0) throw new Error('Activity ZIP is empty');
  const preferred =
    entries.find(([name]) => kindOf(name) === 'fit') ??
    entries.find(([name]) => kindOf(name) !== 'other') ??
    entries[0]!;
  return { name: preferred[0], kind: kindOf(preferred[0]), bytes: preferred[1] };
}

// ---------------------------------------------------------------------------
// Value cleaning

const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;
const POSITION_FIELD = /(PositionLat|PositionLong|^positionLat|^positionLong|^nec(Lat|Long)|^swc(Lat|Long))$/;

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function cleanValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (POSITION_FIELD.test(key)) return round(value * SEMICIRCLE_TO_DEG, 6);
    return Number.isInteger(value) ? value : round(value);
  }
  if (Array.isArray(value)) {
    const arr = value.map((v) => cleanValue(key, v)).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof value === 'object') return undefined; // developer-field blobs etc.
  return value;
}

/** Drop undefined/unknown (numeric-keyed) fields, convert dates and semicircles. */
export function cleanMessage(msg: Msg, pick?: readonly string[]): Msg {
  const out: Msg = {};
  const keys = pick ?? Object.keys(msg);
  for (const key of keys) {
    if (/^\d+$/.test(key)) continue;
    const v = cleanValue(key, msg[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** min:sec per km from m/s. */
export function paceMinPerKm(speed: number | undefined): string | undefined {
  if (!speed || speed <= 0.1) return undefined;
  const secPerKm = 1000 / speed;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return sec === 60 ? `${min + 1}:00` : `${min}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Time series

interface Sample {
  t: number; // seconds since first record
  values: Record<string, number | undefined>;
}

const SERIES_FIELDS: Array<{ column: string; read: (r: Msg) => number | undefined; gps?: boolean }> = [
  { column: 'distance_m', read: (r) => num(r.distance) },
  { column: 'heart_rate', read: (r) => num(r.heartRate) },
  { column: 'speed_mps', read: (r) => num(r.enhancedSpeed) ?? num(r.speed) },
  { column: 'power_w', read: (r) => num(r.power) },
  {
    column: 'cadence',
    read: (r) => {
      const c = num(r.cadence);
      return c === undefined ? undefined : c + (num(r.fractionalCadence) ?? 0);
    },
  },
  { column: 'altitude_m', read: (r) => num(r.enhancedAltitude) ?? num(r.altitude) },
  { column: 'grade_pct', read: (r) => num(r.grade) },
  { column: 'temperature_c', read: (r) => num(r.temperature) },
  { column: 'vertical_oscillation_mm', read: (r) => num(r.verticalOscillation) },
  { column: 'stance_time_ms', read: (r) => num(r.stanceTime) },
  { column: 'step_length_mm', read: (r) => num(r.stepLength) },
  { column: 'vertical_ratio_pct', read: (r) => num(r.verticalRatio) },
  { column: 'respiration_rate', read: (r) => num(r.enhancedRespirationRate) ?? num(r.respirationRate) },
  { column: 'lat', read: (r) => scaleSemi(r.positionLat), gps: true },
  { column: 'lon', read: (r) => scaleSemi(r.positionLong), gps: true },
];

function scaleSemi(value: unknown): number | undefined {
  const n = num(value);
  return n === undefined ? undefined : round(n * SEMICIRCLE_TO_DEG, 6);
}

function toSamples(records: Msg[]): Sample[] {
  const withTime = records
    .map((r) => ({ r, ms: timeMs(r.timestamp) }))
    .filter((x): x is { r: Msg; ms: number } => x.ms !== undefined)
    .sort((a, b) => a.ms - b.ms);
  if (withTime.length === 0) return [];
  const t0 = withTime[0]!.ms;
  return withTime.map(({ r, ms }) => {
    const values: Record<string, number | undefined> = {};
    for (const f of SERIES_FIELDS) values[f.column] = f.read(r);
    return { t: (ms - t0) / 1000, values };
  });
}

/** Bucket-average samples down to at most `maxPoints` rows. */
export function downsample(samples: Sample[], maxPoints: number, includeGps: boolean) {
  const columns = SERIES_FIELDS.filter((f) => (includeGps || !f.gps) && samples.some((s) => s.values[f.column] !== undefined)).map(
    (f) => f.column,
  );
  if (samples.length === 0) return { columns: ['t_s', ...columns], rows: [] as Array<Array<number | null>>, bucket_seconds: 0 };
  const duration = samples[samples.length - 1]!.t;
  const bucketCount = Math.max(1, Math.min(maxPoints, samples.length));
  const bucketSeconds = duration / bucketCount || 1;
  const buckets: Sample[][] = Array.from({ length: bucketCount }, () => []);
  for (const s of samples) {
    const index = Math.min(bucketCount - 1, Math.floor(s.t / bucketSeconds));
    buckets[index]!.push(s);
  }
  const rows: Array<Array<number | null>> = [];
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    const mid = bucket[Math.floor(bucket.length / 2)]!;
    const row: Array<number | null> = [Math.round(bucket[0]!.t)];
    for (const column of columns) {
      if (column === 'lat' || column === 'lon' || column === 'distance_m') {
        // Positions and cumulative distance: representative sample, not an average.
        const v = mid.values[column] ?? bucket.find((s) => s.values[column] !== undefined)?.values[column];
        row.push(v === undefined ? null : round(v, column === 'distance_m' ? 1 : 6));
        continue;
      }
      let sum = 0;
      let n = 0;
      for (const s of bucket) {
        const v = s.values[column];
        if (v !== undefined) {
          sum += v;
          n++;
        }
      }
      row.push(n ? round(sum / n, 2) : null);
    }
    rows.push(row);
  }
  return { columns: ['t_s', ...columns], rows, bucket_seconds: round(bucketSeconds, 1) };
}

/** Resample one column to 1 Hz with forward fill across gaps of at most `maxGap` seconds. */
function resample1Hz(samples: Sample[], column: string, maxGap = 10): Array<number | null> {
  if (samples.length === 0) return [];
  const length = Math.floor(samples[samples.length - 1]!.t) + 1;
  const out: Array<number | null> = new Array(length).fill(null);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const v = s.values[column];
    if (v === undefined) continue;
    const from = Math.floor(s.t);
    const nextT = i + 1 < samples.length ? samples[i + 1]!.t : s.t + 1;
    const to = Math.min(length, Math.floor(nextT), from + maxGap);
    for (let k = from; k < Math.max(to, from + 1) && k < length; k++) out[k] = v;
  }
  return out;
}

/** Best average of a 1 Hz series over each window; windows containing gaps are skipped (or zero-filled). */
function bestRollingMeans(series: Array<number | null>, windows: number[], zeroFill: boolean) {
  const values = series.map((v) => (v === null ? (zeroFill ? 0 : NaN) : v));
  const result: Array<{ window_s: number; value: number }> = [];
  for (const w of windows) {
    if (w > values.length) continue;
    let sum = 0;
    let gaps = 0;
    let best = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (Number.isNaN(v)) gaps++;
      else sum += v;
      if (i >= w) {
        const old = values[i - w]!;
        if (Number.isNaN(old)) gaps--;
        else sum -= old;
      }
      if (i >= w - 1 && gaps === 0) best = Math.max(best, sum / w);
    }
    if (best > -Infinity) result.push({ window_s: w, value: round(best, 1) });
  }
  return result;
}

const DISTANCES = [400, 1000, 1609.34, 5000, 10000, 21097.5, 42195];

/** Fastest elapsed time for each standard distance, from cumulative distance. */
/** Sports where pace (min/km) is the natural unit; everything else gets km/h. */
const PACE_SPORTS = new Set(['running', 'walking', 'hiking', 'trail_running', 'mountaineering', 'snowshoeing', 'cross_country_skiing']);

function speedFields(speed: number | undefined, usePace: boolean): Record<string, string | number> {
  if (speed === undefined || speed <= 0) return {};
  if (usePace) {
    const pace = paceMinPerKm(speed);
    return pace ? { pace_min_per_km: pace } : {};
  }
  return { speed_kmh: round(speed * 3.6, 1) };
}

function fastestDistances(samples: Sample[], usePace: boolean) {
  const pts = samples
    .map((s) => ({ t: s.t, d: s.values.distance_m }))
    .filter((p): p is { t: number; d: number } => p.d !== undefined);
  if (pts.length < 2) return [];
  const total = pts[pts.length - 1]!.d - pts[0]!.d;
  const out: Array<Record<string, string | number>> = [];
  for (const D of DISTANCES) {
    if (D > total) break;
    let best = Infinity;
    let i = 0;
    for (let j = 1; j < pts.length; j++) {
      while (i + 1 < j && pts[j]!.d - pts[i + 1]!.d >= D) i++;
      if (pts[j]!.d - pts[i]!.d >= D) {
        // Interpolate within the last sample interval to where distance D is reached.
        const prev = pts[j - 1]!;
        const covered = prev.d - pts[i]!.d;
        const step = pts[j]!.d - prev.d;
        const t = j - 1 > i && step > 0 ? prev.t + ((D - covered) / step) * (pts[j]!.t - prev.t) : pts[j]!.t;
        best = Math.min(best, t - pts[i]!.t);
      }
    }
    if (best < Infinity && best > 0) {
      out.push({ distance_m: D, seconds: round(best, 1), ...speedFields(D / best, usePace) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zones

export interface HrZoneFloors {
  /** Lower bound of zones 1..5 in bpm. */
  floors: [number, number, number, number, number];
  max?: number;
  source: string;
}

function zonesFromTimeInZone(msg: Msg, timeKey: string, boundaryKey: string, unit: string) {
  const times = msg[timeKey];
  const bounds = msg[boundaryKey];
  if (!Array.isArray(times) || !Array.isArray(bounds) || times.length === 0) return undefined;
  const total = times.reduce((a: number, b) => a + (num(b) ?? 0), 0);
  // FIT layout: boundaries[i] is the high boundary of zone i; zone 0 is "below zone 1".
  return times.map((seconds, zone) => ({
    zone,
    [`from_${unit}`]: zone === 0 ? 0 : num(bounds[zone - 1]),
    [`to_${unit}`]: num(bounds[zone]),
    seconds: round(num(seconds) ?? 0, 0),
    pct: total ? round(((num(seconds) ?? 0) / total) * 100, 1) : 0,
  }));
}

function zonesFromSeries(hr: Array<number | null>, zones: HrZoneFloors) {
  const counts = [0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const v of hr) {
    if (v === null) continue;
    total++;
    let z = 0;
    for (let i = 0; i < 5; i++) if (v >= zones.floors[i]!) z = i + 1;
    counts[z]!++;
  }
  return counts.map((seconds, zone) => ({
    zone,
    from_bpm: zone === 0 ? 0 : zones.floors[zone - 1],
    to_bpm: zone === 0 ? zones.floors[0] : zone < 5 ? zones.floors[zone] : zones.max,
    seconds,
    pct: total ? round((seconds / total) * 100, 1) : 0,
  }));
}

// ---------------------------------------------------------------------------
// Main entry

export interface AnalyzeOptions {
  maxPoints?: number;
  includeGps?: boolean;
  includeTimeseries?: boolean;
  includeLaps?: boolean;
  /** Fallback HR zones when the file has no time-in-zone messages. */
  hrZones?: HrZoneFloors;
}

const LAP_FIELDS = [
  'startTime',
  'totalElapsedTime',
  'totalTimerTime',
  'totalDistance',
  'avgSpeed',
  'maxSpeed',
  'avgHeartRate',
  'maxHeartRate',
  'avgPower',
  'maxPower',
  'normalizedPower',
  'avgCadence',
  'avgFractionalCadence',
  'totalAscent',
  'totalDescent',
  'avgTemperature',
  'totalCalories',
  'intensity',
  'lapTrigger',
  'wktStepIndex',
  'avgVerticalOscillation',
  'avgStanceTime',
  'avgStepLength',
  'avgVerticalRatio',
  'numLengths',
  'avgSwolf',
  'swimStroke',
  'repetitionNum',
] as const;

export function analyzeFit(bytes: Uint8Array, options: AnalyzeOptions = {}) {
  const maxPoints = Math.max(10, Math.min(options.maxPoints ?? 200, 2000));
  const stream = Stream.fromByteArray(Array.from(bytes));
  if (!Decoder.isFIT(stream)) throw new Error('Not a FIT file');
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    includeUnknownData: false,
    mergeHeartRates: true,
  });
  const m = messages as unknown as Record<string, Msg[] | undefined>;
  const list = (key: string): Msg[] => m[key] ?? [];

  const records = list('recordMesgs');
  const samples = toSamples(records);
  const hr1Hz = resample1Hz(samples, 'heart_rate');
  const power1Hz = resample1Hz(samples, 'power_w');
  const hasPower = power1Hz.some((v) => v !== null);
  const hasHr = hr1Hz.some((v) => v !== null);

  const sessionMsgs = list('sessionMesgs');
  const sport = String(sessionMsgs[0]?.sport ?? list('sportMesgs')[0]?.sport ?? '');
  const usePace = PACE_SPORTS.has(sport);
  const sessions = sessionMsgs.map((s) => {
    const clean = cleanMessage(s);
    const avg = speedFields(num(s.enhancedAvgSpeed) ?? num(s.avgSpeed), usePace);
    for (const [k, v] of Object.entries(avg)) clean[`avg_${k}`] = v;
    return clean;
  });

  // Time in zones: prefer what the device computed (session-level time_in_zone).
  const tiz = list('timeInZoneMesgs');
  const sessionTiz = tiz.find((t) => t.referenceMesg === 'session') ?? tiz[tiz.length - 1];
  let hrZones: unknown;
  let hrZonesSource: string | undefined;
  if (sessionTiz) {
    hrZones = zonesFromTimeInZone(sessionTiz, 'timeInHrZone', 'hrZoneHighBoundary', 'bpm');
    if (hrZones) hrZonesSource = 'device (FIT time_in_zone)';
  }
  if (!hrZones && hasHr && options.hrZones) {
    hrZones = zonesFromSeries(hr1Hz, options.hrZones);
    hrZonesSource = `computed from records using ${options.hrZones.source}`;
  }
  const powerZones = sessionTiz
    ? zonesFromTimeInZone(sessionTiz, 'timeInPowerZone', 'powerZoneHighBoundary', 'w')
    : undefined;

  const laps = list('lapMesgs').map((lap, index) => {
    const clean = cleanMessage(lap, LAP_FIELDS);
    const speed = num(lap.enhancedAvgSpeed) ?? num(lap.avgSpeed);
    if (speed !== undefined) clean.avgSpeed = round(speed);
    return { lap: index + 1, ...clean, ...speedFields(speed, usePace) };
  });

  const rr = list('hrvMesgs').flatMap((h) => (Array.isArray(h.time) ? h.time : [])).filter((v): v is number => num(v) !== undefined && v > 0.25 && v < 2.5);
  let beatToBeat: unknown;
  if (rr.length > 10) {
    let sq = 0;
    for (let i = 1; i < rr.length; i++) sq += (rr[i]! - rr[i - 1]!) ** 2;
    const meanRr = rr.reduce((a, b) => a + b, 0) / rr.length;
    beatToBeat = { beats: rr.length, mean_rr_ms: round(meanRr * 1000, 1), rmssd_ms: round(Math.sqrt(sq / (rr.length - 1)) * 1000, 1) };
  }

  const sets = list('setMesgs').map((s) => cleanMessage(s, ['startTime', 'setType', 'category', 'categorySubtype', 'repetitions', 'weight', 'duration', 'wktStepIndex']));
  const lengths = list('lengthMesgs');

  const devices = new Map<string, Msg>();
  for (const d of list('deviceInfoMesgs')) {
    const clean = cleanMessage(d, ['deviceIndex', 'manufacturer', 'product', 'productName', 'deviceType', 'sourceType', 'softwareVersion', 'batteryStatus']);
    devices.set(JSON.stringify([clean.manufacturer, clean.product, clean.productName, clean.deviceType]), clean);
  }

  const durationS = samples.length ? samples[samples.length - 1]!.t : 0;
  return {
    file: list('fileIdMesgs').map((f) => cleanMessage(f))[0],
    sport: list('sportMesgs').map((s) => cleanMessage(s))[0],
    sessions,
    laps: options.includeLaps === false ? undefined : laps,
    hr_zones: hrZones ? { source: hrZonesSource, zones: hrZones } : undefined,
    power_zones: powerZones,
    best_efforts: {
      power_w: hasPower ? bestRollingMeans(power1Hz, [5, 30, 60, 300, 600, 1200, 3600], true) : undefined,
      heart_rate: hasHr ? bestRollingMeans(hr1Hz, [60, 300, 1200, 3600], false) : undefined,
      fastest_distances: fastestDistances(samples, usePace),
    },
    beat_to_beat_hrv: beatToBeat,
    strength_sets: sets.length ? sets : undefined,
    swim_lengths: lengths.length
      ? {
          count: lengths.length,
          active: lengths.filter((l) => l.lengthType === 'active').length,
          lengths: lengths.length <= 200 ? lengths.map((l) => cleanMessage(l, ['startTime', 'totalTimerTime', 'totalStrokes', 'avgSpeed', 'swimStroke', 'avgSwimmingCadence', 'lengthType'])) : undefined,
        }
      : undefined,
    splits: list('splitMesgs').slice(0, 100).map((s) => cleanMessage(s)),
    split_summaries: list('splitSummaryMesgs').map((s) => cleanMessage(s)),
    workout_steps: list('workoutStepMesgs').map((s) => cleanMessage(s)),
    devices: [...devices.values()],
    records: {
      count: records.length,
      duration_s: round(durationS, 0),
      has_gps: samples.some((s) => s.values.lat !== undefined),
      has_power: hasPower,
      has_heart_rate: hasHr,
    },
    timeseries:
      options.includeTimeseries === false ? undefined : downsample(samples, maxPoints, options.includeGps ?? false),
    notes: [
      'cadence is as recorded in FIT: running cadence is per leg (strides/min); double it for steps/min.',
      'Positions are decimal degrees. best_efforts use elapsed time (pauses included).',
    ],
    decode_errors: errors.length ? errors.map((e: unknown) => String(e)).slice(0, 5) : undefined,
  };
}
