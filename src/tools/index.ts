import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { GarminApi } from '../garmin/api.js';
import type { GarminClient, Query } from '../garmin/client.js';
import { resolveDate, resolveRange, type DateRangeInput } from '../garmin/dates.js';
import { analyzeFit, extractActivityFile, type HrZoneFloors } from '../garmin/fit.js';
import { errorResult, jsonResult } from './result.js';

export const SERVER_NAME = 'garmin-connect';
export const SERVER_VERSION = '0.1.0';

export interface ToolOptions {
  /** Register tools that touch the local filesystem (stdio mode only). */
  localFileAccess?: boolean;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// ---- Shared input schemas ---------------------------------------------------

const dateField = z
  .string()
  .optional()
  .describe('Calendar date YYYY-MM-DD in your local calendar, or "today", "yesterday", "-3d". Defaults to today.');

const rangeFields = {
  start_date: z.string().optional().describe('Inclusive start date (YYYY-MM-DD, "today", "-30d"). Defaults to end_date - (days - 1).'),
  end_date: z.string().optional().describe('Inclusive end date (YYYY-MM-DD, "today", "-1d"). Defaults to today.'),
  days: z.number().int().min(1).max(3650).optional().describe('Number of days ending at end_date, used when start_date is omitted. Default 7.'),
};

const activityIdField = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).describe('Garmin activity ID (from search_activities).');

// ---- Helpers ----------------------------------------------------------------

/** Activity search returns ~150 fields per activity; these are the ones worth reading by default. */
const COMPACT_ACTIVITY_FIELDS = [
  'activityId',
  'activityName',
  'startTimeLocal',
  'activityType',
  'eventType',
  'distance',
  'duration',
  'movingDuration',
  'elapsedDuration',
  'elevationGain',
  'elevationLoss',
  'averageSpeed',
  'maxSpeed',
  'averageHR',
  'maxHR',
  'averageRunningCadenceInStepsPerMinute',
  'averageBikingCadenceInRevPerMinute',
  'avgPower',
  'maxPower',
  'normPower',
  'trainingStressScore',
  'intensityFactor',
  'aerobicTrainingEffect',
  'anaerobicTrainingEffect',
  'trainingEffectLabel',
  'activityTrainingLoad',
  'vO2MaxValue',
  'calories',
  'steps',
  'hrTimeInZone_1',
  'hrTimeInZone_2',
  'hrTimeInZone_3',
  'hrTimeInZone_4',
  'hrTimeInZone_5',
  'moderateIntensityMinutes',
  'vigorousIntensityMinutes',
  'totalSets',
  'totalReps',
  'locationName',
  'isPR',
  'isFavorite',
  'parentId',
  'description',
] as const;

function compactActivity(activity: unknown): unknown {
  if (!activity || typeof activity !== 'object') return activity;
  const a = activity as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of COMPACT_ACTIVITY_FIELDS) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    if ((key === 'activityType' || key === 'eventType') && typeof v === 'object') {
      out[key] = (v as Record<string, unknown>).typeKey ?? v;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Replace long arrays with a short note; used for overview-style composite tools. */
function stripLargeArrays(value: unknown, maxLength = 24, hint = ''): unknown {
  if (Array.isArray(value)) {
    if (value.length > maxLength) return `[${value.length} items omitted${hint ? ` — ${hint}` : ''}]`;
    return value.map((v) => stripLargeArrays(v, maxLength, hint));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripLargeArrays(v, maxLength, hint);
    return out;
  }
  return value;
}

function settled<T>(result: PromiseSettledResult<T>): T | { error: string } {
  return result.status === 'fulfilled'
    ? result.value
    : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

async function hrZoneFloors(api: GarminApi): Promise<HrZoneFloors | undefined> {
  try {
    const zones = (await api.heartRateZones()) as Array<Record<string, unknown>> | null;
    const z0 = zones?.find((z) => z.sport === 'DEFAULT') ?? zones?.[0];
    if (!z0) return undefined;
    const floors = [z0.zone1Floor, z0.zone2Floor, z0.zone3Floor, z0.zone4Floor, z0.zone5Floor];
    if (!floors.every((f) => typeof f === 'number')) return undefined;
    return {
      floors: floors as HrZoneFloors['floors'],
      max: typeof z0.maxHeartRateUsed === 'number' ? z0.maxHeartRateUsed : undefined,
      source: `Garmin Connect zones (${String(z0.trainingMethod ?? 'unknown method')}, sport ${String(z0.sport)})`,
    };
  } catch {
    return undefined;
  }
}

/** Paths reachable via the generic GET tool: Garmin service paths only, never the token service. */
export function isAllowedApiPath(p: string): boolean {
  if (!/^\/[a-z0-9-]+-service\/[A-Za-z0-9_\-./]*$/.test(p)) return false;
  if (p.includes('..') || p.includes('//')) return false;
  return !p.startsWith('/personalapitoken-service');
}

// ---- Server factory ---------------------------------------------------------

export function createGarminServer(client: GarminClient, options: ToolOptions = {}): McpServer {
  const api = new GarminApi(client);
  const tz = client.config.timeZone;
  const date = (input?: string) => resolveDate(input, tz);
  const range = (input: DateRangeInput, defaultDays = 7) => resolveRange(input, tz, defaultDays);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: [
        'Read-only access to the user\'s Garmin Connect data via Garmin\'s official Personal API.',
        `Dates are calendar dates in the user's local calendar (server time zone ${tz}); "today", "yesterday" and "-7d" are accepted.`,
        'Start with get_daily_overview for "how am I doing today" questions, search_activities to find workouts, and analyze_activity for per-second detail (laps, zones, best efforts, time series) of one activity.',
        'Range tools split long ranges automatically into Garmin\'s per-request limits.',
        'Garmin\'s Personal API cannot write data: workouts, courses, weight or food cannot be created or changed.',
      ].join(' '),
    },
  );

  function tool<S extends z.ZodObject>(
    name: string,
    config: { title: string; description: string; input: S },
    handler: (args: z.infer<S>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: config.input, annotations: { title: config.title, ...READ_ONLY } },
      (async (args: z.infer<S>): Promise<CallToolResult> => {
        try {
          const result = await handler(args);
          if (result && typeof result === 'object' && 'content' in result && Array.isArray((result as CallToolResult).content)) {
            return result as CallToolResult;
          }
          return jsonResult(result);
        } catch (error) {
          return errorResult(error);
        }
      }) as never,
    );
  }

  // ---- Profile ----------------------------------------------------------------

  tool(
    'get_profile',
    {
      title: 'Profile settings',
      description: 'User profile settings: display name, locale, measurement system, time zone, hydration containers, training days.',
      input: z.object({}),
    },
    () => api.profileSettings(),
  );

  tool(
    'get_heart_rate_zones',
    {
      title: 'Heart rate zones',
      description: 'Configured heart-rate zones per sport: zone floors, max HR, resting HR, lactate threshold HR and training method.',
      input: z.object({ generate_defaults: z.boolean().optional().describe('Generate default zones if none are configured. Default true.') }),
    },
    (a) => api.heartRateZones(a.generate_defaults ?? true),
  );

  // ---- Daily wellness ------------------------------------------------------

  tool(
    'get_daily_overview',
    {
      title: 'Daily overview',
      description:
        'One-call snapshot of a day: daily summary (steps, calories, stress, Body Battery, resting HR, SpO2, respiration, intensity minutes), sleep, HRV status, Body Battery report and the day\'s activities. Large sample arrays are omitted; use the dedicated tools for detail.',
      input: z.object({ date: dateField }),
    },
    async (a) => {
      const d = date(a.date);
      const [summary, sleep, hrv, bodyBattery, activities] = await Promise.allSettled([
        api.dailySummary(d),
        api.dailySleep(d),
        api.hrv(d),
        api.bodyBattery(d, d),
        api.searchActivities({ start: 0, limit: 20, startDate: d, endDate: d }),
      ]);
      const hint = 'use the dedicated tool for the full series';
      const hrvValue = settled(hrv);
      return {
        date: d,
        summary: settled(summary),
        sleep: stripLargeArrays(settled(sleep), 24, hint),
        hrv:
          hrvValue && typeof hrvValue === 'object' && 'hrvSummary' in hrvValue
            ? { hrvSummary: (hrvValue as Record<string, unknown>).hrvSummary }
            : hrvValue,
        body_battery: stripLargeArrays(settled(bodyBattery), 24, hint),
        activities: (() => {
          const v = settled(activities);
          return Array.isArray(v) ? v.map(compactActivity) : v;
        })(),
      };
    },
  );

  tool(
    'get_daily_summary',
    {
      title: 'Daily summary',
      description:
        'Full wellness summary for one date: steps, distance, floors, calories (active/BMR/consumed), intensity minutes, min/max/resting HR, stress durations and levels, Body Battery high/low/charged/drained, SpO2, respiration, hydration, sync time.',
      input: z.object({ date: dateField }),
    },
    (a) => api.dailySummary(date(a.date)),
  );

  tool(
    'get_daily_summaries',
    {
      title: 'Daily summaries (range)',
      description:
        'Daily summaries (v2) for a date range: movement, calories, heart rate, intensity minutes, stress, Body Battery, hydration, respiration, pulse ox and jet lag per day. Up to 1 year per request; longer ranges are split automatically.',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a);
      return api.dailySummaries(r.start, r.end);
    },
  );

  tool(
    'get_steps',
    {
      title: 'Daily steps',
      description: 'Total steps, distance and step goal per day for a date range (split into 28-day requests automatically).',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a);
      return api.dailySteps(r.start, r.end);
    },
  );

  tool(
    'get_stress',
    {
      title: 'Daily stress',
      description: 'Daily stress values (average/max stress level and related values) for a date range (28-day chunks).',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a);
      return api.dailyStress(r.start, r.end);
    },
  );

  tool(
    'get_hydration',
    {
      title: 'Daily hydration',
      description: 'Hydration intake, goal, sweat loss and activity intake (ml) per day for a date range (31-day chunks).',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a);
      return api.dailyHydration(r.start, r.end);
    },
  );

  tool(
    'get_heart_rate',
    {
      title: 'Daily heart rate',
      description:
        'Heart rate for one date: resting, min, max, 7-day average resting HR, abnormal HR events and the intraday HR samples ([timestamp_ms, bpm] pairs, ~2 min resolution). Set include_samples=false for summary only.',
      input: z.object({
        date: dateField,
        include_samples: z.boolean().optional().describe('Include the intraday sample array. Default true.'),
      }),
    },
    async (a) => {
      const data = (await api.dailyHeartRate(date(a.date))) as Record<string, unknown> | null;
      if (data && a.include_samples === false) {
        const { heartRateValues, ...rest } = data;
        return { ...rest, heartRateValues: Array.isArray(heartRateValues) ? `[${heartRateValues.length} samples omitted]` : heartRateValues };
      }
      return data;
    },
  );

  tool(
    'get_body_battery',
    {
      title: 'Body Battery',
      description:
        'Daily Body Battery reports: charged/drained, intraday values, feedback events and activity events per day for a date range (31-day chunks).',
      input: z.object({
        ...rangeFields,
        chunks: z.number().int().positive().optional().describe('Optional Garmin "chunks" parameter passed through to the API.'),
      }),
    },
    (a) => {
      const r = range(a, 1);
      return api.bodyBattery(r.start, r.end, a.chunks);
    },
  );

  tool(
    'get_spo2',
    {
      title: 'Pulse Ox (SpO2)',
      description: 'SpO2 and altitude acclimation for one date: average, lowest, latest, sleep SpO2, 7-day average and single readings.',
      input: z.object({ date: dateField }),
    },
    (a) => api.dailySpo2(date(a.date)),
  );

  // ---- Sleep / HRV -----------------------------------------------------------

  tool(
    'get_sleep',
    {
      title: 'Sleep (one night)',
      description:
        'Detailed sleep for one date (the night ending that morning): total/deep/light/REM/awake seconds, sleep score and feedback, sleep need, SpO2, respiration, restless moments, naps and timestamps.',
      input: z.object({ date: dateField }),
    },
    (a) => api.dailySleep(date(a.date)),
  );

  tool(
    'get_sleep_summaries',
    {
      title: 'Sleep summaries (range)',
      description: 'Nightly sleep summaries for a date range (31-day chunks). Use for trends; use get_sleep for one night in detail.',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a);
      return api.sleepSummaries(r.start, r.end);
    },
  );

  tool(
    'get_hrv',
    {
      title: 'HRV (one night)',
      description: 'Heart rate variability for one date: overnight summary (weekly average, last-night average, baseline, status) plus individual readings.',
      input: z.object({ date: dateField }),
    },
    (a) => api.hrv(date(a.date)),
  );

  tool(
    'get_hrv_summaries',
    {
      title: 'HRV summaries (range)',
      description: 'Daily HRV summaries (status, weekly average, last night, baseline) for a date range.',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a);
      return api.hrvSummaries(r.start, r.end);
    },
  );

  // ---- Body composition / goals ---------------------------------------------

  tool(
    'get_weight',
    {
      title: 'Weight summary',
      description:
        'Weight summary for a date range: latest weight per day, range average and the nearest weigh-ins before/after. include_all_entries adds every weigh-in per day. Weights are in grams as returned by Garmin.',
      input: z.object({
        ...rangeFields,
        include_all_entries: z.boolean().optional().describe('Include every weigh-in for each day. Default false.'),
      }),
    },
    (a) => {
      const r = range(a, 30);
      return api.weightRange(r.start, r.end, a.include_all_entries ?? false);
    },
  );

  tool(
    'get_weight_entries',
    {
      title: 'Weight entries',
      description: 'Every weigh-in in a date range with body composition (BMI, body fat, body water, bone and muscle mass, visceral fat, metabolic age).',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a, 30);
      return api.weightEntries(r.start, r.end);
    },
  );

  tool(
    'get_weight_goals',
    {
      title: 'Weight goals',
      description: 'Effective weight goals and goal ranges for a date range.',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a, 30);
      return api.weightGoals(r.start, r.end);
    },
  );

  tool(
    'get_fitness_age',
    {
      title: 'Fitness age',
      description: 'Fitness age as of a date: chronological vs fitness age, achievable fitness age and contributing components (VO2 max, BMI/body fat, resting HR, vigorous activity).',
      input: z.object({
        date: dateField,
        full_history_scan: z.boolean().optional().describe('Scan full history (default true). If false, only the last 28 days are considered.'),
      }),
    },
    (a) => api.fitnessAge(date(a.date), a.full_history_scan ?? true),
  );

  // ---- Nutrition -------------------------------------------------------------

  tool(
    'get_nutrition',
    {
      title: 'Nutrition log',
      description: 'Food log for one date: nutrition goals, total nutrients consumed, logged foods with serving sizes and per-meal breakdown.',
      input: z.object({
        date: dateField,
        include_goals: z.boolean().optional().describe('Default true.'),
        include_nutrition: z.boolean().optional().describe('Include nutrient totals. Default true.'),
        include_media: z.boolean().optional().describe('Include food images metadata. Default false here to save space.'),
        meal_id: z.number().int().optional().describe('Restrict to one meal ID.'),
      }),
    },
    (a) =>
      api.foodLogs(date(a.date), {
        includeGoals: a.include_goals ?? true,
        includeNutrition: a.include_nutrition ?? true,
        includeMedia: a.include_media ?? false,
        mealId: a.meal_id,
      }),
  );

  // ---- Women's health ---------------------------------------------------------

  tool(
    'get_menstrual_cycle_summary',
    {
      title: 'Menstrual cycle summary',
      description: 'Menstrual cycle summary as of a date: current phase, day in cycle, predicted cycle and ovulation, fertile window, pregnancy tracking.',
      input: z.object({ date: dateField }),
    },
    (a) => api.menstrualCycleSummary(date(a.date)),
  );

  tool(
    'get_menstrual_cycle_day',
    {
      title: 'Menstrual cycle day',
      description: 'Detailed menstrual cycle view for one day: logged symptoms, flow and mood, the cycle summary for that day and pregnancy weight goal ranges.',
      input: z.object({
        date: dateField,
        today_date: z.string().optional().describe('The user\'s current date (YYYY-MM-DD). Defaults to today.'),
        reduced_response: z.boolean().optional(),
        include_analysis: z.boolean().optional(),
        skipbm: z.boolean().optional().describe('Garmin "skipbm" flag, passed through.'),
      }),
    },
    (a) =>
      api.menstrualCycleDayView(date(a.date), {
        todayDate: date(a.today_date),
        reducedResponse: a.reduced_response,
        includeAnalysis: a.include_analysis,
        skipbm: a.skipbm,
      }),
  );

  // ---- Activities --------------------------------------------------------------

  tool(
    'search_activities',
    {
      title: 'Search activities',
      description:
        'Search and list activities (newest first by default) with filters for date, type, text, distance, duration, elevation, power, area and more. Returns compact summaries unless full=true. Use the activityId with get_activity / analyze_activity.',
      input: z.object({
        start_date: z.string().optional().describe('Inclusive earliest local start date (YYYY-MM-DD, "-30d").'),
        end_date: z.string().optional().describe('Inclusive latest local start date.'),
        start: z.number().int().min(0).optional().describe('Zero-based offset for pagination. Default 0.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max activities to return. Default 20.'),
        activity_type: z.string().optional().describe('Parent type key, e.g. running, cycling, swimming, strength_training, hiking, walking.'),
        activity_sub_type: z.string().optional().describe('Subtype key, e.g. trail_running, treadmill_running, road_biking, indoor_cycling, lap_swimming.'),
        event_type: z.string().optional().describe('race, training, recreation, fitness, specialEvent or uncategorized.'),
        search: z.string().optional().describe('Text in activity name or description.'),
        favorite: z.boolean().optional().describe('true = only favorites, false = only non-favorites.'),
        sort_by: z.string().optional().describe('Field to sort by, e.g. startLocal (default), distance, duration, name.'),
        sort_order: z.enum(['asc', 'desc']).optional(),
        include_children: z.boolean().optional().describe('Include child activities of multisport parents. Default false.'),
        min_distance_m: z.number().int().optional(),
        max_distance_m: z.number().int().optional(),
        min_duration_s: z.number().int().optional().describe('Minimum timer duration in seconds.'),
        max_duration_s: z.number().int().optional(),
        min_elapsed_duration_s: z.number().int().optional(),
        max_elapsed_duration_s: z.number().int().optional(),
        min_elevation_gain_m: z.number().int().optional(),
        max_elevation_gain_m: z.number().int().optional(),
        min_avg_power_w: z.number().int().optional(),
        excluded_activity_sub_type: z.string().optional(),
        required_field: z.string().optional().describe('Only activities that have this field, passed through as requiredField.'),
        bounding_box: z
          .object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() })
          .optional()
          .describe('Start-location bounding box in decimal degrees.'),
        dive: z
          .object({
            deco_dive: z.boolean().optional(),
            min_max_depth_m: z.number().optional(),
            max_max_depth_m: z.number().optional(),
            min_bottom_time_s: z.number().int().optional(),
            max_bottom_time_s: z.number().int().optional(),
          })
          .optional()
          .describe('Dive filters.'),
        full: z.boolean().optional().describe('Return every field Garmin provides (large). Default false.'),
      }),
    },
    async (a) => {
      const query: Query = {
        start: a.start ?? 0,
        limit: a.limit ?? 20,
        startDate: a.start_date ? date(a.start_date) : undefined,
        endDate: a.end_date ? date(a.end_date) : undefined,
        activityType: a.activity_type,
        activitySubType: a.activity_sub_type,
        eventType: a.event_type,
        search: a.search,
        favorite: a.favorite === undefined ? undefined : a.favorite ? 1 : 0,
        sortBy: a.sort_by,
        sortOrder: a.sort_order,
        excludeChildren: a.include_children === undefined ? undefined : !a.include_children,
        minDistance: a.min_distance_m,
        maxDistance: a.max_distance_m,
        minDuration: a.min_duration_s,
        maxDuration: a.max_duration_s,
        minElapsedDuration: a.min_elapsed_duration_s,
        maxElapsedDuration: a.max_elapsed_duration_s,
        minElevation: a.min_elevation_gain_m,
        maxElevation: a.max_elevation_gain_m,
        minAvgPower: a.min_avg_power_w,
        excludedActivitySubType: a.excluded_activity_sub_type,
        requiredField: a.required_field,
        upperLatitude: a.bounding_box?.north,
        lowerLatitude: a.bounding_box?.south,
        rightLongitude: a.bounding_box?.east,
        leftLongitude: a.bounding_box?.west,
        decoDive: a.dive?.deco_dive,
        lowerMaxDepth: a.dive?.min_max_depth_m,
        upperMaxDepth: a.dive?.max_max_depth_m,
        minBottomTime: a.dive?.min_bottom_time_s,
        maxBottomTime: a.dive?.max_bottom_time_s,
      };
      const activities = (await api.searchActivities(query)) ?? [];
      const list = Array.isArray(activities) ? activities : [activities];
      return {
        count: list.length,
        start: query.start,
        next_start: list.length === query.limit ? Number(query.start) + list.length : undefined,
        activities: a.full ? list : list.map(compactActivity),
      };
    },
  );

  tool(
    'get_activity',
    {
      title: 'Activity details',
      description:
        'Full summary of one activity: type, metadata, device, all summary metrics (pace, HR, power, cadence, running dynamics, training effect, load, stamina, etc.) and split summaries. For laps, zones and time series use analyze_activity.',
      input: z.object({ activity_id: activityIdField }),
    },
    (a) => api.activity(a.activity_id),
  );

  tool(
    'get_activity_workouts',
    {
      title: 'Activity workouts',
      description: 'The structured workout(s) performed during an activity: workout name, sport and steps with targets.',
      input: z.object({ activity_id: activityIdField }),
    },
    (a) => api.activityWorkouts(a.activity_id),
  );

  tool(
    'analyze_activity',
    {
      title: 'Analyze activity file',
      description:
        'Downloads the original activity file (FIT) and analyzes it: sessions, laps with pace, time in HR and power zones, best efforts (best 5s-60min power, best HR windows, fastest 400m-marathon), beat-to-beat HRV, strength sets, swim lengths, devices and a downsampled time series (HR, speed, power, cadence, altitude, running dynamics, optional GPS).',
      input: z.object({
        activity_id: activityIdField,
        max_points: z.number().int().min(10).max(2000).optional().describe('Max rows in the time series. Default 200.'),
        include_gps: z.boolean().optional().describe('Include lat/lon columns in the time series. Default false.'),
        include_timeseries: z.boolean().optional().describe('Default true.'),
        include_laps: z.boolean().optional().describe('Default true.'),
      }),
    },
    async (a) => {
      const download = await api.downloadActivity(a.activity_id);
      const file = extractActivityFile(download.bytes, `activity-${a.activity_id}`);
      if (file.kind !== 'fit') {
        return {
          activity_id: a.activity_id,
          file: { name: file.name, kind: file.kind, bytes: file.bytes.length },
          note: 'The original file is not FIT (likely a manual or imported activity). Only FIT files are analyzed; use get_activity for its summary.',
        };
      }
      const zones = await hrZoneFloors(api);
      return {
        activity_id: a.activity_id,
        file_name: file.name,
        ...analyzeFit(file.bytes, {
          maxPoints: a.max_points,
          includeGps: a.include_gps,
          includeTimeseries: a.include_timeseries,
          includeLaps: a.include_laps,
          hrZones: zones,
        }),
      };
    },
  );

  tool(
    'get_wellness_activities',
    {
      title: 'Wellness activities',
      description: 'Wellness activity summaries (e.g. breathwork, meditation, health snapshots) with summary values and time in zones for a date range.',
      input: z.object(rangeFields),
    },
    (a) => {
      const r = range(a, 30);
      return api.wellnessActivities(r.start, r.end);
    },
  );

  // ---- Escape hatch -------------------------------------------------------------

  tool(
    'garmin_api_get',
    {
      title: 'Raw Personal API GET',
      description:
        'Call any GET endpoint of the Garmin Personal API directly (for endpoints Garmin adds later). Path must start with "/<name>-service/". Returns raw JSON. Prefer the dedicated tools.',
      input: z.object({
        path: z.string().describe('API path, e.g. /usersummary-service/usersummary/daily'),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query parameters.'),
      }),
    },
    async (a) => {
      if (!isAllowedApiPath(a.path)) {
        throw new Error('Path not allowed. It must look like /<name>-service/... and may not target the token service.');
      }
      if (a.path.startsWith('/download-service/')) {
        throw new Error('Use analyze_activity for file downloads.');
      }
      return client.get(a.path, a.query);
    },
  );

  // ---- Local-only -----------------------------------------------------------------

  if (options.localFileAccess) {
    tool(
      'save_activity_file',
      {
        title: 'Save original activity file',
        description: 'Download an activity\'s original file (ZIP from Garmin) and save it locally. Optionally extract the FIT/GPX/TCX inside. Local (stdio) mode only.',
        input: z.object({
          activity_id: activityIdField,
          directory: z.string().describe('Directory to save into (created if missing).'),
          extract: z.boolean().optional().describe('Save the extracted FIT/GPX/TCX instead of the ZIP. Default false.'),
          overwrite: z.boolean().optional().describe('Replace an existing file. Default false.'),
        }),
      },
      async (a) => {
        const download = await api.downloadActivity(a.activity_id);
        const dir = path.resolve(a.directory);
        await mkdir(dir, { recursive: true });
        let name = `activity-${a.activity_id}.zip`;
        let bytes = download.bytes;
        if (a.extract) {
          const file = extractActivityFile(download.bytes, `activity-${a.activity_id}`);
          name = path.basename(file.name);
          bytes = file.bytes;
        }
        const target = path.join(dir, name);
        await writeFile(target, bytes, { flag: a.overwrite ? 'w' : 'wx' });
        return { saved: target, bytes: bytes.length };
      },
    );
  }

  // ---- Prompts ---------------------------------------------------------------------

  server.registerPrompt(
    'training_week_review',
    {
      title: 'Training week review',
      description: 'Review the last N days of training, recovery and sleep.',
      argsSchema: z.object({ days: z.string().optional().describe('Number of days, default 7') }),
    },
    ({ days }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review my last ${days || '7'} days using my Garmin data. Use search_activities for the period, get_daily_summaries, get_sleep_summaries and get_hrv_summaries for recovery, and analyze_activity for my key sessions. Summarize load, intensity distribution, sleep and HRV trend, and give concrete recommendations for the coming week.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'recovery_check',
    {
      title: 'Recovery check',
      description: 'Assess readiness to train today from sleep, HRV, Body Battery, stress and resting HR.',
      argsSchema: z.object({ date: z.string().optional().describe('Date, default today') }),
    },
    ({ date: d }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Assess my recovery for ${d || 'today'}. Call get_daily_overview for that date and get_hrv_summaries and get_sleep_summaries for the preceding 14 days as baseline. Tell me whether to train hard, easy or rest, and why.`,
          },
        },
      ],
    }),
  );

  return server;
}
