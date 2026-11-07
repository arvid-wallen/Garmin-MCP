import { describe, expect, it } from 'vitest';

import { GarminApi } from '../src/garmin/api.js';
import { GarminClient } from '../src/garmin/client.js';
import { fakeGarmin, fakeJwt, garminConfig, json } from './helpers.js';

describe('GarminClient', () => {
  it('exchanges the API key once and reuses the bearer token', async () => {
    const g = fakeGarmin([[/userprofile/, () => json({ displayName: 'me' })]]);
    const client = new GarminClient(garminConfig, g.fetch);
    await client.get('/userprofile-service/userprofile/settings');
    await client.get('/userprofile-service/userprofile/settings');
    expect(g.tokenCount()).toBe(1);
    const dataCall = g.calls.find((c) => c.url.pathname.includes('userprofile'))!;
    expect(dataCall.headers.get('authorization')).toMatch(/^Bearer /);
    expect(g.calls[0]!.method).toBe('POST');
  });

  it('refreshes a token that is about to expire', async () => {
    const g = fakeGarmin([[/userprofile/, () => json({})]], { token: () => fakeJwt(30 * 60) });
    const client = new GarminClient(garminConfig, g.fetch);
    await client.get('/userprofile-service/userprofile/settings');
    await client.get('/userprofile-service/userprofile/settings');
    expect(g.tokenCount()).toBe(2);
  });

  it('shares one exchange between concurrent callers', async () => {
    const g = fakeGarmin([[/userprofile/, () => json({})]]);
    const client = new GarminClient(garminConfig, g.fetch);
    await Promise.all([1, 2, 3].map(() => client.get('/userprofile-service/userprofile/settings')));
    expect(g.tokenCount()).toBe(1);
  });

  it('retries once with a fresh token on 401', async () => {
    let n = 0;
    const g = fakeGarmin([[/userprofile/, () => (n++ === 0 ? new Response('expired', { status: 401 }) : json({ ok: true }))]]);
    const client = new GarminClient(garminConfig, g.fetch);
    expect(await client.get('/userprofile-service/userprofile/settings')).toEqual({ ok: true });
    expect(g.tokenCount()).toBe(2);
  });

  it('retries 429 and surfaces other errors without leaking the key', async () => {
    let n = 0;
    const g = fakeGarmin([
      [/userprofile/, () => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } }) : json({ ok: 1 }))],
      [/hrv-service/, () => new Response('{"message":"bad date"}', { status: 400 })],
    ]);
    const client = new GarminClient(garminConfig, g.fetch);
    expect(await client.get('/userprofile-service/userprofile/settings')).toEqual({ ok: 1 });
    const error = await client.get('/hrv-service/hrv/bad').catch((e: Error) => e);
    expect(String(error)).toContain('Garmin API 400');
    expect(String(error)).not.toContain('test-key');
  });

  it('returns null for empty bodies', async () => {
    const g = fakeGarmin([[/sleep/, () => new Response(null, { status: 204 })]]);
    expect(await new GarminClient(garminConfig, g.fetch).get('/sleep-service/sleep/dailySleep')).toBeNull();
  });

  it('reports a bad API key clearly', async () => {
    const g = fakeGarmin([]);
    const client = new GarminClient({ ...garminConfig, apiKey: 'wrong' }, g.fetch);
    await expect(client.get('/userprofile-service/userprofile/settings')).rejects.toThrow(/Garmin API 401/);
  });
});

describe('GarminApi range chunking', () => {
  it('splits steps into 28-day requests and merges them', async () => {
    const g = fakeGarmin([
      [
        /stats\/steps\/daily/,
        (url) => {
          const [, , , , , start, end] = url.pathname.split('/');
          return json([{ calendarDate: start, end }]);
        },
      ],
    ]);
    const api = new GarminApi(new GarminClient(garminConfig, g.fetch));
    const result = await api.dailySteps('2026-01-01', '2026-03-01');
    expect(result).toHaveLength(3);
    const paths = g.calls.filter((c) => c.url.pathname.includes('steps')).map((c) => c.url.pathname);
    expect(paths).toContain('/usersummary-service/stats/steps/daily/2026-01-01/2026-01-28');
    expect(paths).toContain('/usersummary-service/stats/steps/daily/2026-02-26/2026-03-01');
  });

  it('merges v2 daily summaries data arrays', async () => {
    const g = fakeGarmin([[/v2\/dailysummaries/, (url) => json({ data: [{ calendarDate: url.searchParams.get('startDate') }] })]]);
    const api = new GarminApi(new GarminClient(garminConfig, g.fetch));
    const result = await api.dailySummaries('2025-01-01', '2026-06-30');
    expect(result.data).toHaveLength(2);
  });

  it('refuses absurd fan-outs', async () => {
    const g = fakeGarmin([[/steps/, () => json([])]]);
    const api = new GarminApi(new GarminClient(garminConfig, g.fetch));
    await expect(api.dailySteps('2010-01-01', '2026-01-01')).rejects.toThrow(/Narrow the range/);
  });
});
