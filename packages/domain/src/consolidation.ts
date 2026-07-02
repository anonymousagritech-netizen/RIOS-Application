/**
 * Legal-entity consolidation engine (Legal Entities gap: a real multi-entity
 * consolidation with intercompany elimination, not just a reporting VIEW).
 *
 * Given the standalone trial balance of each legal entity in a group plus the
 * set of account codes that carry intercompany balances, this computes the
 * consolidated group trial balance:
 *
 *   1. line-by-line aggregation of every non-intercompany account across all
 *      entities (full consolidation, 100% line-by-line - the standard model);
 *   2. intercompany elimination: each entity's balance on an intercompany
 *      account is removed and recorded as an elimination entry, because an
 *      intercompany receivable in one member mirrors a payable in another and
 *      must not survive into the group accounts. When the balances truly mirror
 *      each other the eliminations net to zero (reported + asserted);
 *   3. minority interest (a labelled *simple* model): for a subsidiary owned
 *      < 100%, the non-controlling share of that subsidiary's standalone net
 *      assets (assets - liabilities) is reported as a memo figure. It is a memo
 *      reclassification within equity, so it does not unbalance the group TB.
 *
 * Pure: no I/O, no DB, no clock. Integer minor units throughout; the server
 * persists the run + its recorded eliminations, this file computes them.
 */

/** GL account nature (mirrors gl_account.type). */
export type ConsolidationAccountType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

/** One account line of a single entity's standalone trial balance. */
export interface ConsolidationAccount {
  code: string;
  name?: string;
  type: ConsolidationAccountType;
  debitMinor: number;
  creditMinor: number;
}

/** A legal entity participating in the consolidation. */
export interface ConsolidationEntity {
  entityId: string;
  /** Ownership held by the group in this entity, 0..100. The group parent is 100. */
  ownershipPct: number;
  accounts: ConsolidationAccount[];
}

export interface ConsolidationInput {
  currency: string;
  /** The group (parent) entity id; excluded from minority interest (wholly the group). */
  groupEntityId?: string;
  entities: ConsolidationEntity[];
  /** Account codes whose inter-member balances are eliminated on consolidation. */
  intercompanyAccounts: string[];
}

/** A recorded intercompany elimination (auditable - persisted per run). */
export interface EliminationEntry {
  accountCode: string;
  entityId: string;
  /** Signed balance removed from the group (debit - credit), integer minor units. */
  netMinor: number;
  debitMinor: number;
  creditMinor: number;
  reason: string;
}

/** A consolidated group account line. */
export interface ConsolidatedAccount {
  code: string;
  name?: string;
  type: ConsolidationAccountType;
  debitMinor: number;
  creditMinor: number;
  /** Net balance in the account's natural direction convenience (debit - credit). */
  netMinor: number;
}

/** Per-entity minority-interest detail (simple net-assets model). */
export interface MinorityInterestEntry {
  entityId: string;
  ownershipPct: number;
  /** Subsidiary standalone net assets (assets - liabilities), integer minor units. */
  netAssetsMinor: number;
  /** Non-controlling share = (100 - ownershipPct)% of net assets, integer minor units. */
  minorityInterestMinor: number;
}

export interface ConsolidationResult {
  currency: string;
  consolidated: ConsolidatedAccount[];
  eliminations: EliminationEntry[];
  /** Sum of removed net balances; zero when intercompany balances mirror. */
  eliminationNetMinor: number;
  eliminationsBalanced: boolean;
  minorityInterest: MinorityInterestEntry[];
  minorityInterestMinor: number;
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  /** Group TB balances (debits === credits) - holds whenever eliminations net to zero. */
  balanced: boolean;
}

/**
 * Standalone net assets (assets - liabilities) of an entity, integer minor units.
 * Equal to book equity + retained result by the accounting identity, so it is a
 * sound base for the non-controlling interest in the subsidiary's net worth.
 */
export function entityNetAssetsMinor(entity: ConsolidationEntity): number {
  let assetNet = 0;
  let liabilityNet = 0;
  for (const a of entity.accounts) {
    if (a.type === 'asset') assetNet += a.debitMinor - a.creditMinor;
    else if (a.type === 'liability') liabilityNet += a.creditMinor - a.debitMinor;
  }
  return assetNet - liabilityNet;
}

/**
 * Consolidate a group of legal entities with intercompany elimination and a
 * simple minority-interest model. All amounts are integer minor units.
 */
export function consolidate(input: ConsolidationInput): ConsolidationResult {
  const ic = new Set(input.intercompanyAccounts.map((c) => c.trim()).filter((c) => c.length > 0));

  const consolidatedMap = new Map<string, ConsolidatedAccount>();
  const eliminations: EliminationEntry[] = [];

  for (const entity of input.entities) {
    for (const acc of entity.accounts) {
      const debit = Math.trunc(acc.debitMinor);
      const credit = Math.trunc(acc.creditMinor);
      if (ic.has(acc.code)) {
        // Remove the entity's intercompany balance from the group and record it.
        if (debit !== 0 || credit !== 0) {
          eliminations.push({
            accountCode: acc.code,
            entityId: entity.entityId,
            netMinor: debit - credit,
            debitMinor: debit,
            creditMinor: credit,
            reason: `Intercompany elimination of ${acc.code} for entity ${entity.entityId}`,
          });
        }
        continue;
      }
      // Full (100% line-by-line) consolidation of non-intercompany accounts.
      const existing = consolidatedMap.get(acc.code);
      if (existing) {
        existing.debitMinor += debit;
        existing.creditMinor += credit;
        existing.netMinor = existing.debitMinor - existing.creditMinor;
      } else {
        consolidatedMap.set(acc.code, {
          code: acc.code,
          name: acc.name,
          type: acc.type,
          debitMinor: debit,
          creditMinor: credit,
          netMinor: debit - credit,
        });
      }
    }
  }

  const consolidated = [...consolidatedMap.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const eliminationNetMinor = eliminations.reduce((s, e) => s + e.netMinor, 0);

  // Minority interest (simple model): non-controlling share of each subsidiary's
  // standalone net assets. The group parent (ownership 100, or groupEntityId) is
  // wholly owned and contributes none.
  const minorityInterest: MinorityInterestEntry[] = [];
  for (const entity of input.entities) {
    if (entity.entityId === input.groupEntityId) continue;
    const own = entity.ownershipPct;
    if (own >= 100) continue;
    const netAssetsMinor = entityNetAssetsMinor(entity);
    const minorityInterestMinor = Math.round((netAssetsMinor * (100 - own)) / 100);
    minorityInterest.push({ entityId: entity.entityId, ownershipPct: own, netAssetsMinor, minorityInterestMinor });
  }
  const minorityInterestMinor = minorityInterest.reduce((s, m) => s + m.minorityInterestMinor, 0);

  const totalDebitsMinor = consolidated.reduce((s, a) => s + a.debitMinor, 0);
  const totalCreditsMinor = consolidated.reduce((s, a) => s + a.creditMinor, 0);

  return {
    currency: input.currency,
    consolidated,
    eliminations,
    eliminationNetMinor,
    eliminationsBalanced: eliminationNetMinor === 0,
    minorityInterest,
    minorityInterestMinor,
    totalDebitsMinor,
    totalCreditsMinor,
    balanced: totalDebitsMinor === totalCreditsMinor,
  };
}
