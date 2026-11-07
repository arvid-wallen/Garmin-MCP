import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Claude caps tool results at roughly 150k characters. Stay well under so
 * several results fit in context.
 */
export const MAX_RESULT_CHARS = 90_000;

/** Evenly sample an array down to `max` items, keeping first and last. */
export function sampleArray<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, max);
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)] as T);
  return out;
}

/** Recursively cap every array at `max` items, recording what was cut. */
function capArrays(value: unknown, max: number, path: string, notes: string[]): unknown {
  if (Array.isArray(value)) {
    const sampled = value.length > max ? sampleArray(value, max) : value;
    if (sampled !== value) notes.push(`${path || '$'}: ${value.length} items sampled to ${sampled.length}`);
    return sampled.map((v, i) => capArrays(v, max, `${path}[${i}]`, notes));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capArrays(v, max, path ? `${path}.${k}` : k, notes);
    return out;
  }
  return value;
}

/** Serialize compactly; if too large, progressively sample long arrays until it fits. */
export function shrinkToFit(data: unknown, limit = MAX_RESULT_CHARS): { text: string; truncated: boolean; notes: string[] } {
  let text = JSON.stringify(data ?? null);
  if (text.length <= limit) return { text, truncated: false, notes: [] };

  for (let max = 512; max >= 4; max = Math.floor(max / 2)) {
    const notes: string[] = [];
    const capped = capArrays(data, max, '', notes);
    // Report only top-level-ish notes to keep the message short.
    const summary = notes.filter((n) => !/\[\d+\]/.test(n)).slice(0, 10);
    const wrapped = {
      _truncated: `Response exceeded ${limit} characters. Long arrays were evenly sampled (max ${max} items). Narrow the date range or request fewer fields for full detail.`,
      _sampled: summary.length ? summary : notes.slice(0, 10),
      data: capped,
    };
    text = JSON.stringify(wrapped);
    if (text.length <= limit) return { text, truncated: true, notes };
  }
  return {
    text: text.slice(0, limit) + '... [hard-truncated]',
    truncated: true,
    notes: ['hard-truncated'],
  };
}

export function jsonResult(data: unknown): CallToolResult {
  if (data === null || data === undefined) {
    return { content: [{ type: 'text', text: 'No data returned by Garmin for this request (null/empty response).' }] };
  }
  const { text } = shrinkToFit(data);
  return { content: [{ type: 'text', text }] };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}
