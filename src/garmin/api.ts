import type { GarminClient, Query } from './client.js';
import { splitRange } from './dates.js';

/**
 * One wrapper per endpoint in Garmin's Personal API OpenAPI spec
 * (docs/garmin-personal-api.openapi.json). Range endpoints are split into
 * chunks that respect Garmin's documented per-request maximums and merged.
 */

/**
 * Max days per request. Documented in the spec: steps/stress 28, sleep,
 * hydration and Body Battery 31, daily summaries 1 year. The rest are not
 * documented, so they use a conservative 31-day chunk.
 */
export const MAX_DAYS = {
  steps: 28,
  stress: 28,
  hydration: 31,
  sleepSummaries: 31,
  bodyBattery: 31,
  dailySummaries: 365,
  hrvSummaries: 31,
  weightEntries: 31,
  wellnessActivities: 31,
} as const;

/** Guardrail against accidental huge fan-outs (e.g. 5 years of steps = 66 calls). */
export const MAX_CHUNKS = 40;
const CONCURRENCY = 4;

export class RangeTooLargeError extends Error {}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function chunked<R>(
  start: string,
  end: string,
  maxDays: number,
  fetchChunk: (start: string, end: string) => Promise<R>,
): Promise<R[]> {
  const chunks = splitRange(start, end, maxDays);
  if (chunks.length > MAX_CHUNKS) {
    throw new RangeTooLargeError(
      `Range ${start}..${end} needs ${chunks.length} requests (max ${MAX_CHUNKS}, ${maxDays} days each). Narrow the range.`,
    );
  }
  return mapLimit(chunks, CONCURRENCY, (c) => fetchChunk(c.start, c.end));
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

export class GarminApi {
  constructor(readonly client: GarminClient) {}

  // ---- User profile -------------------------------------------------------

  profileSettings() {
    return this.client.get('/userprofile-service/userprofile/settings');
  }

  heartRateZones(generateDefaults = true) {
    return this.client.get('/biometric-service/heartRateZones/v2', { generateDefaults });
  }

  // ---- Daily wellness -----------------------------------------------------

  dailySummary(date: string) {
    return this.client.get('/usersummary-service/usersummary/daily', { calendarDate: date });
  }

  async dailySummaries(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.dailySummaries, (s, e) =>
      this.client.get<{ data?: unknown[] }>('/usersummary-service/v2/dailysummaries', { startDate: s, endDate: e }),
    );
    return { data: parts.flatMap((p) => asArray(p?.data)) };
  }

  async dailySteps(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.steps, (s, e) =>
      this.client.get(`/usersummary-service/stats/steps/daily/${s}/${e}`),
    );
    return parts.flatMap(asArray);
  }

  async dailyStress(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.stress, (s, e) =>
      this.client.get(`/usersummary-service/stats/stress/daily/${s}/${e}`),
    );
    return parts.flatMap(asArray);
  }

  async dailyHydration(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.hydration, (s, e) =>
      this.client.get(`/usersummary-service/stats/hydration/daily/${s}/${e}`),
    );
    return parts.flatMap(asArray);
  }

  dailyHeartRate(date: string) {
    return this.client.get('/wellness-service/wellness/dailyHeartRate', { date });
  }

  dailySpo2(date: string) {
    return this.client.get(`/wellness-service/wellness/daily/spo2acclimation/${date}`);
  }

  async bodyBattery(start: string, end: string, chunks?: number) {
    const parts = await chunked(start, end, MAX_DAYS.bodyBattery, (s, e) =>
      this.client.get('/wellness-service/wellness/bodyBattery/reports/daily', { startDate: s, endDate: e, chunks }),
    );
    return parts.flatMap(asArray);
  }

  // ---- Sleep / HRV --------------------------------------------------------

  dailySleep(date: string) {
    return this.client.get('/sleep-service/sleep/dailySleep', { date });
  }

  async sleepSummaries(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.sleepSummaries, (s, e) =>
      this.client.get('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: s, endDate: e }),
    );
    return parts.flatMap(asArray);
  }

  hrv(date: string) {
    return this.client.get(`/hrv-service/hrv/${date}`);
  }

  async hrvSummaries(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.hrvSummaries, (s, e) =>
      this.client.get<{ hrvSummaries?: unknown[]; userProfilePk?: number }>(`/hrv-service/hrv/daily/${s}/${e}`),
    );
    return {
      userProfilePk: parts.find((p) => p?.userProfilePk !== undefined)?.userProfilePk,
      hrvSummaries: parts.flatMap((p) => asArray(p?.hrvSummaries)),
    };
  }

  // ---- Body composition / goals -------------------------------------------

  /** Not chunked: the response contains range-level aggregates (totalAverage). */
  weightRange(start: string, end: string, includeAll = false) {
    return this.client.get(`/weight-service/weight/range/${start}/${end}`, { includeAll });
  }

  async weightEntries(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.weightEntries, (s, e) =>
      this.client.get(`/weight-service/weight/all/${s}/${e}`),
    );
    return parts.flatMap(asArray);
  }

  weightGoals(start: string, end: string) {
    return this.client.get(`/goal-service/goal/user/effective/weightgoal/${start}/${end}`);
  }

  fitnessAge(date: string, fullHistoryScan = true) {
    return this.client.get(`/fitnessage-service/fitnessage/v2/${date}`, { fullHistoryScan });
  }

  // ---- Nutrition ----------------------------------------------------------

  foodLogs(date: string, query: { includeGoals?: boolean; includeNutrition?: boolean; includeMedia?: boolean; mealId?: number }) {
    return this.client.get(`/nutrition-service/food/logs/${date}`, query);
  }

  // ---- Women's health -----------------------------------------------------

  menstrualCycleSummary(date: string) {
    return this.client.get(`/periodichealth-service/menstrualcycle/summary/${date}`);
  }

  menstrualCycleDayView(
    date: string,
    query: { todayDate?: string; reducedResponse?: boolean; skipbm?: boolean; includeAnalysis?: boolean },
  ) {
    return this.client.get(`/periodichealth-service/menstrualcycle/dayview/${date}`, query);
  }

  // ---- Activities ---------------------------------------------------------

  searchActivities(query: Query) {
    return this.client.get<unknown[]>('/activitylist-service/activities/search/activities', query);
  }

  activity(activityId: number | string) {
    return this.client.get(`/activity-service/activity/${activityId}`);
  }

  activityWorkouts(activityId: number | string) {
    return this.client.get(`/activity-service/activity/${activityId}/workouts`);
  }

  downloadActivity(activityId: number | string) {
    return this.client.getBytes(`/download-service/files/activity/${activityId}`);
  }

  async wellnessActivities(start: string, end: string) {
    const parts = await chunked(start, end, MAX_DAYS.wellnessActivities, (s, e) =>
      this.client.get(`/wellnessactivity-service/activity/summary/range/${s}/${e}`),
    );
    return parts.flatMap(asArray);
  }
}
