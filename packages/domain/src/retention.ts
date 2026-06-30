/**
 * Data retention & legal hold (brief §14 - retention & legal hold). Pure policy
 * logic deciding whether a record may be disposed of: it is eligible only once
 * it has aged past its retention period AND no legal hold covers it. The domain
 * stays clock-free - the server computes the record's age in days and passes it
 * in. A legal hold always wins, so litigation data is never purged on schedule.
 */

export type RetentionAction = 'archive' | 'purge';

export interface LegalHold {
  /** When set, the hold only covers this entity type; absent = a global hold. */
  entityType?: string | null;
  /** When set, the hold only covers this specific record. */
  entityId?: string | null;
  active: boolean;
}

/** Does any active hold cover the given record? An unscoped hold covers everything. */
export function hasActiveHold(holds: LegalHold[], entityType: string, entityId?: string): boolean {
  return (holds ?? []).some((h) => {
    if (!h.active) return false;
    if (h.entityType && h.entityType !== entityType) return false;
    if (h.entityId && h.entityId !== entityId) return false;
    return true;
  });
}

export type RetentionReason = 'eligible' | 'within_retention' | 'legal_hold';

export interface RetentionVerdict {
  ageDays: number;
  retentionDays: number;
  onHold: boolean;
  /** True only when aged past retention AND not on hold. */
  eligible: boolean;
  reason: RetentionReason;
}

/**
 * Decide a record's disposition. Eligible when `ageDays >= retentionDays` and
 * not on hold. A hold short-circuits to `legal_hold` regardless of age.
 */
export function retentionVerdict(ageDays: number, retentionDays: number, onHold: boolean): RetentionVerdict {
  const agedOut = ageDays >= retentionDays;
  const eligible = agedOut && !onHold;
  const reason: RetentionReason = onHold ? 'legal_hold' : agedOut ? 'eligible' : 'within_retention';
  return { ageDays, retentionDays, onHold, eligible, reason };
}

/** Whole days between two epoch-millisecond instants (never negative). */
export function ageInDays(recordedAtMs: number, asOfMs: number): number {
  return Math.max(0, Math.floor((asOfMs - recordedAtMs) / 86_400_000));
}
