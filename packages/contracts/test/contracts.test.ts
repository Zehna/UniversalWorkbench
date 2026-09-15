import { describe, expect, it } from 'vitest';
import {
  ErrorEnvelopeSchema,
  HealthStatusSchema,
  ReadinessStatusSchema
} from '../src/index.js';

describe('foundation contracts', () => {
  it('accepts a valid error envelope and rejects a missing code', () => {
    expect(ErrorEnvelopeSchema.parse({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected failure', requestId: 'req_1' }
    })).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected failure', requestId: 'req_1' }
    });

    expect(() => ErrorEnvelopeSchema.parse({ error: { message: 'bad' } })).toThrow();
  });

  it('validates live and ready health payloads', () => {
    expect(HealthStatusSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(ReadinessStatusSchema.parse({
      status: 'ready',
      checks: { database: 'ok' }
    })).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });
});
