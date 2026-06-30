import { describe, it, expect } from 'vitest';
import { direction, resolveBundle, interpolate, translate } from '../src/i18n.js';

describe('direction', () => {
  it('detects RTL languages', () => {
    expect(direction('ar-EG')).toBe('rtl');
    expect(direction('he')).toBe('rtl');
    expect(direction('en-US')).toBe('ltr');
    expect(direction('fr')).toBe('ltr');
  });
});

describe('bundle resolution', () => {
  it('overlays the locale over the fallback', () => {
    const b = resolveBundle({ greeting: 'Bonjour' }, { greeting: 'Hello', bye: 'Bye' });
    expect(b).toEqual({ greeting: 'Bonjour', bye: 'Bye' });
  });
});

describe('interpolate & translate', () => {
  it('substitutes placeholders and leaves unknowns intact', () => {
    expect(interpolate('Hi {name}, you have {n}', { name: 'Ada', n: 3 })).toBe('Hi Ada, you have 3');
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}');
  });
  it('falls back to the key when missing', () => {
    expect(translate({ welcome: 'Welcome {who}' }, 'welcome', { who: 'Ada' })).toBe('Welcome Ada');
    expect(translate({}, 'missing.key')).toBe('missing.key');
  });
});
