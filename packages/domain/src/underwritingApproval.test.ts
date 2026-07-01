import { describe, it, expect } from 'vitest';
import {
  requiredApproval, escalationChain, levelCovers, slaDueAt, isSlaBreached,
  LEVEL_PERMISSION, APPROVAL_LEVELS,
} from './underwritingApproval.js';

const M = (major: number) => major * 100;

describe('underwriting approval matrix', () => {
  it('keeps small, low-risk business within delegated authority (no referral)', () => {
    const r = requiredApproval({ band: 'LOW', limitMinor: M(2_000_000) });
    expect(r.level).toBe('UNDERWRITER');
    expect(r.referralRequired).toBe(false);
    expect(r.chain).toEqual(['UNDERWRITER']);
  });

  it('refers elevated band to senior underwriter', () => {
    const r = requiredApproval({ band: 'ELEVATED', limitMinor: M(1_000_000) });
    expect(r.level).toBe('SENIOR_UW');
    expect(r.referralRequired).toBe(true);
  });

  it('refers a 10m+ limit to senior underwriter even at low band', () => {
    const r = requiredApproval({ band: 'LOW', limitMinor: M(12_000_000) });
    expect(r.level).toBe('SENIOR_UW');
  });

  it('refers HIGH band to chief underwriter', () => {
    const r = requiredApproval({ band: 'HIGH', limitMinor: M(1_000_000) });
    expect(r.level).toBe('CHIEF_UW');
    expect(r.reason).toBe('High risk band');
  });

  it('escalates the largest limits to committee (highest level wins)', () => {
    const r = requiredApproval({ band: 'HIGH', limitMinor: M(150_000_000) });
    expect(r.level).toBe('COMMITTEE');
    expect(r.chain).toEqual(['UNDERWRITER', 'SENIOR_UW', 'CHIEF_UW', 'COMMITTEE']);
  });

  it('maps every level to a permission and orders levels by authority', () => {
    for (const lvl of APPROVAL_LEVELS) expect(LEVEL_PERMISSION[lvl]).toBeTruthy();
    expect(levelCovers('CHIEF_UW', 'SENIOR_UW')).toBe(true);
    expect(levelCovers('SENIOR_UW', 'CHIEF_UW')).toBe(false);
    expect(levelCovers('COMMITTEE', 'UNDERWRITER')).toBe(true);
  });

  it('builds the escalation chain up to a level', () => {
    expect(escalationChain('CHIEF_UW')).toEqual(['UNDERWRITER', 'SENIOR_UW', 'CHIEF_UW']);
  });

  it('computes SLA due time and breach', () => {
    const raised = 1_000_000_000_000;
    const due = slaDueAt(raised, 'CHIEF_UW'); // 24h
    expect(due).toBe(raised + 24 * 3600_000);
    expect(isSlaBreached(raised, 'CHIEF_UW', due - 1)).toBe(false);
    expect(isSlaBreached(raised, 'CHIEF_UW', due + 1)).toBe(true);
  });
});
