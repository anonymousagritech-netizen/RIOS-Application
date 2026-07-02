/**
 * Sanctions feed provider adapter (brief §12 - compliance / sanctions).
 *
 * The sanctions denylist (`sanctions_list_entry`) and the pure screening matcher
 * (`screenName`) already exist; this module adds the missing piece - loading the
 * list from a provider and re-screening the party book against it.
 *
 * The feed is abstracted behind the `SanctionsFeedProvider` interface. RIOS
 * ships a working in-repo `BundledSampleFeedProvider` (a small, clearly-synthetic
 * OFAC-style sample list) so screening produces real hits without an external
 * subscription; a live OFAC / EU / UN / UK-OFSI feed is the labelled integration
 * seam that implements the same interface (and would be driven by the scheduler
 * for periodic refresh). Reads need party:read; refresh / screen-all need
 * party:write and are audited.
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { screenName, type SanctionsListName } from './parties.js';

export interface SanctionsFeedEntry {
  fullName: string;
  alias?: string;
  country?: string;
  note?: string;
}

/** The feed seam: a provider returns the entries to load for its source. */
export interface SanctionsFeedProvider {
  readonly source: string;
  readonly name: string;
  fetch(): Promise<SanctionsFeedEntry[]>;
}

/**
 * Default in-repo provider. The names are clearly-synthetic samples (not real
 * designations) so the demo screens with real hits; a licensed feed replaces
 * this class behind the same interface.
 */
export class BundledSampleFeedProvider implements SanctionsFeedProvider {
  readonly source = 'OFAC-SAMPLE';
  readonly name = 'BUNDLED';
  async fetch(): Promise<SanctionsFeedEntry[]> {
    return [
      { fullName: 'Sanctioned Holdings International', alias: 'SHI', country: 'XX', note: 'sample entity' },
      { fullName: 'Redlist Trading Company', alias: 'RTC', country: 'XX', note: 'sample entity' },
      { fullName: 'Blocked Maritime Services', country: 'XX', note: 'sample entity' },
      { fullName: 'Denied Reinsurance Partners', alias: 'DRP', country: 'XX', note: 'sample entity' },
    ];
  }
}

const defaultProvider: SanctionsFeedProvider = new BundledSampleFeedProvider();

export async function sanctionsFeedModule(app: FastifyInstance): Promise<void> {
  // Refresh the denylist for the provider's source: replace this source's
  // entries with the provider's current set and log the refresh.
  app.post('/api/sanctions/refresh', { preHandler: requirePermission('party:write') }, async (req) => {
    const ctx = authContext(req);
    const entries = await defaultProvider.fetch();
    return runAs(ctx, async (db) => {
      await db.query(`delete from sanctions_list_entry where list_source = $1`, [defaultProvider.source]);
      for (const e of entries) {
        await db.query(
          `insert into sanctions_list_entry (tenant_id, list_source, full_name, alias, country, note)
           values (app_current_tenant(), $1, $2, $3, $4, $5)`,
          [defaultProvider.source, e.fullName, e.alias ?? null, e.country ?? null, e.note ?? null],
        );
      }
      const { rows } = await db.query(
        `insert into sanctions_feed_refresh (tenant_id, source, provider, entry_count, refreshed_by)
         values (app_current_tenant(), $1, $2, $3, $4)
         returning id, source, provider, entry_count as "entryCount", refreshed_at as "refreshedAt"`,
        [defaultProvider.source, defaultProvider.name, entries.length, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'sanctions.feed.refresh', entityType: 'sanctions_list_entry',
        after: { source: defaultProvider.source, provider: defaultProvider.name, entryCount: entries.length },
      });
      return { refresh: rows[0], entryCount: entries.length };
    });
  });

  // List the current denylist entries.
  app.get('/api/sanctions/list', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, list_source as "listSource", full_name as "fullName", alias, country, note
           from sanctions_list_entry order by list_source, full_name limit 2000`,
      );
      return { entries: rows };
    });
  });

  // Latest refresh per source, plus current entry counts.
  app.get('/api/sanctions/status', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows: refreshes } = await db.query(
        `select distinct on (source) source, provider, entry_count as "entryCount",
                refreshed_at as "refreshedAt"
           from sanctions_feed_refresh order by source, refreshed_at desc`,
      );
      const { rows: counts } = await db.query(
        `select list_source as "source", count(*)::int as "count"
           from sanctions_list_entry group by list_source`,
      );
      return { refreshes, counts, provider: defaultProvider.name, defaultSource: defaultProvider.source };
    });
  });

  // Re-screen every active party against the current denylist, recording a
  // screening row for each non-clear result. Returns the hit summary.
  app.post('/api/sanctions/screen-all', { preHandler: requirePermission('party:write') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows: listRows } = await db.query(
        `select id, list_source as "listSource", full_name as "fullName", alias from sanctions_list_entry`,
      );
      const list: SanctionsListName[] = listRows.map((r) => ({ id: r.id, name: r.fullName, listSource: r.listSource }));
      const { rows: parties } = await db.query(
        `select id, legal_name as "legalName" from party where not is_deleted`,
      );
      let blocked = 0, potential = 0, clear = 0;
      for (const p of parties) {
        const { result, matches } = screenName(p.legalName, list);
        if (result === 'CLEAR') { clear++; continue; }
        if (result === 'BLOCKED') blocked++; else potential++;
        await db.query(
          `insert into sanctions_screening (tenant_id, party_id, screened_name, result, matches, screened_by)
           values (app_current_tenant(), $1, $2, $3, $4::jsonb, $5)`,
          [p.id, p.legalName, result, JSON.stringify(matches), ctx.userId],
        );
      }
      await writeAudit(db, ctx, {
        action: 'sanctions.screen.all', entityType: 'sanctions_screening',
        after: { screened: parties.length, blocked, potential },
      });
      return { screened: parties.length, blocked, potential, clear };
    });
  });
}
