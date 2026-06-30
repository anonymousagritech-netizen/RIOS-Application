import { describe, it, expect } from 'vitest';
import { validateConnectorConfig, redactConfig } from '../src/integration.js';

describe('validateConnectorConfig', () => {
  it('requires the right fields per kind', () => {
    expect(validateConnectorConfig('rest', { baseUrl: 'https://api.example.com' })).toEqual([]);
    expect(validateConnectorConfig('sftp', { host: 'sftp.example.com', username: 'u' })).toEqual([]);
    expect(validateConnectorConfig('kafka', { brokers: ['b1'], topic: 't' })).toEqual([]);
    const restMissing = validateConnectorConfig('rest', {});
    expect(restMissing.map((i) => i.field)).toEqual(['baseUrl']);
  });

  it('flags a non-http URL', () => {
    const issues = validateConnectorConfig('webhook', { url: 'ftp://x' });
    expect(issues.some((i) => i.message.includes('http'))).toBe(true);
  });

  it('rejects an unknown kind', () => {
    // @ts-expect-error testing runtime guard
    expect(validateConnectorConfig('mystery', {}).length).toBe(1);
  });
});

describe('redactConfig', () => {
  it('masks secret-bearing keys', () => {
    const r = redactConfig({ baseUrl: 'https://x', apiKey: 'abc', password: 'p', token: '' });
    expect(r.baseUrl).toBe('https://x');
    expect(r.apiKey).toBe('••••••');
    expect(r.password).toBe('••••••');
    expect(r.token).toBe(''); // empty stays empty
  });
});
