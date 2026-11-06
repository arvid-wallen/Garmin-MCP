import { describe, expect, it } from 'vitest';

import { isAllowedApiPath } from '../src/tools/index.js';
import { sampleArray, shrinkToFit } from '../src/tools/result.js';

describe('result shaping', () => {
  it('passes small payloads through untouched', () => {
    expect(shrinkToFit({ a: [1, 2, 3] })).toEqual({ text: '{"a":[1,2,3]}', truncated: false, notes: [] });
  });

  it('samples long arrays to fit the limit', () => {
    const big = { heartRateValues: Array.from({ length: 20000 }, (_, i) => [1_700_000_000_000 + i * 120_000, 60 + (i % 40)]) };
    const { text, truncated } = shrinkToFit(big, 50_000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(50_000);
    const parsed = JSON.parse(text) as { _truncated: string; data: { heartRateValues: unknown[] } };
    expect(parsed._truncated).toContain('sampled');
    expect(parsed.data.heartRateValues.length).toBeGreaterThan(10);
  });

  it('keeps first and last when sampling', () => {
    expect(sampleArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([1, 6, 10]);
  });

  it('restricts the raw GET tool to service paths', () => {
    expect(isAllowedApiPath('/usersummary-service/usersummary/daily')).toBe(true);
    expect(isAllowedApiPath('/personalapitoken-service/personal-api/personal-api-key/token')).toBe(false);
    expect(isAllowedApiPath('https://evil.example/x')).toBe(false);
    expect(isAllowedApiPath('/foo-service/../../etc')).toBe(false);
    expect(isAllowedApiPath('//evil.example/x-service/')).toBe(false);
  });
});
