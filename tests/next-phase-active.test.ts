import { describe, expect, it, vi } from 'vitest';
import {
  isFollowUpEventType,
  shouldRejectByStoryKey,
  shapeStoryKeyMetrics,
  cleanupStoryIntelligenceEvents,
  getStoryIntelligenceRetentionDays,
  isStoryIntelligenceRejectActive,
} from '../apps/worker-api/src/services/story-intelligence';
import {
  computeSourceSelectionWeight,
  orderByReputationWeight,
} from '../apps/worker-api/src/services/apify-rotation-runner';
import {
  decideQualitySteer,
  shapeAiCostBySource,
  shapeQueryYield,
} from '../apps/worker-api/src/services/observability-reports';

describe('6K active reject logic (pure)', () => {
  it('recognizes follow-up event types that must not be blocked', () => {
    expect(isFollowUpEventType('security_recovery')).toBe(true);
    expect(isFollowUpEventType('etf_decision')).toBe(true);
    expect(isFollowUpEventType('lawsuit_update')).toBe(true);
    expect(isFollowUpEventType('hack_update')).toBe(true); // *_update
    expect(isFollowUpEventType('security_laundering')).toBe(false);
  });

  it('rejects a repeated story key only when active + seen + not a follow-up', () => {
    const base = { rejectEnabled: true, storyKeySeenInWindow: true, followupAllowEnabled: true };
    expect(shouldRejectByStoryKey({ ...base, eventType: 'security_laundering' })).toBe(true);
    expect(shouldRejectByStoryKey({ ...base, eventType: 'security_recovery' })).toBe(false); // follow-up allowed
    expect(shouldRejectByStoryKey({ ...base, storyKeySeenInWindow: false, eventType: 'x' })).toBe(false);
    expect(shouldRejectByStoryKey({ ...base, rejectEnabled: false, eventType: 'x' })).toBe(false);
    // follow-up allow disabled → even a follow-up gets blocked
    expect(shouldRejectByStoryKey({ rejectEnabled: true, storyKeySeenInWindow: true, followupAllowEnabled: false, eventType: 'security_recovery' })).toBe(true);
  });

  it('shapes story_key metrics with would-block estimate', () => {
    const rows = [
      { story_key: 'a', event_type: 'etf_flows' },
      { story_key: 'a', event_type: 'etf_flows' },       // repeat, not follow-up → would block
      { story_key: 'b', event_type: 'exploit' },
      { story_key: 'b', event_type: 'exploit_update' },  // repeat but follow-up → allowed
    ];
    const m = shapeStoryKeyMetrics(rows);
    expect(m.storyKeyTotal).toBe(4);
    expect(m.storyKeyUnique).toBe(2);
    expect(m.storyKeyRepeated).toBe(2);
    expect(m.wouldBlockCountIfRejectEnabled).toBe(1); // only the non-followup repeat
    expect(m.topRepeatedStoryKeys[0]!.count).toBe(2);
  });
});

describe('source reputation weighting (pure)', () => {
  it('returns neutral weight below min sample', () => {
    const cfg = { minSample: 20, maxWeight: 2, minWeight: 0.3 };
    expect(computeSourceSelectionWeight({ published: 5, rejected: 0, sample: 5 }, cfg)).toBe(1);
  });
  it('maps acceptance to [minWeight, maxWeight]', () => {
    const cfg = { minSample: 5, maxWeight: 2, minWeight: 0.4 };
    expect(computeSourceSelectionWeight({ published: 10, rejected: 0, sample: 10 }, cfg)).toBe(2);   // 100% acceptance
    expect(computeSourceSelectionWeight({ published: 0, rejected: 10, sample: 10 }, cfg)).toBe(0.4); // 0% acceptance
  });
  it('orders by weight but keeps exploration slots as round-robin', () => {
    const plans = [{ source: { id: 'low' } }, { source: { id: 'high' } }];
    const w = new Map([['low', 0.3], ['high', 2.0]]);
    expect(orderByReputationWeight(plans, w, 0, 20)[0]!.source.id).toBe('low');  // exploration slot
    expect(orderByReputationWeight(plans, w, 1, 20)[0]!.source.id).toBe('high'); // weighted slot
  });

  it('cooldown prevents one high-reputation source from dominating (12-slot sim)', () => {
    const plans = [{ source: { id: 'A' } }, { source: { id: 'B' } }, { source: { id: 'C' } }];
    const w = new Map([['A', 2.0], ['B', 1.0], ['C', 1.0]]);
    const recent = new Map<string, number>([['A', 0], ['B', 0], ['C', 0]]);
    const firsts: Record<string, number> = { A: 0, B: 0, C: 0 };
    for (let slot = 0; slot < 12; slot++) {
      const ordered = orderByReputationWeight(plans, w, slot, 0, recent); // no exploration → pure weight+cooldown
      const winner = ordered[0]!.source.id;
      firsts[winner]!++;
      recent.set(winner, (recent.get(winner) ?? 0) + 1); // simulate "ran this slot"
    }
    // A is better so leads more, but must NOT dominate 8–9/12; B and C get real turns.
    expect(firsts.A).toBeLessThanOrEqual(6);
    expect(firsts.B).toBeGreaterThanOrEqual(2);
    expect(firsts.C).toBeGreaterThanOrEqual(2);
  });
});

describe('apify query yield (pure)', () => {
  it('separates duplicates from candidates and computes rates + source_id', () => {
    const items = [
      { source_account: 'A', source_id: 'src_a', status: 'ai_selected', reject_reason: null, count: 3 },
      { source_account: 'A', source_id: 'src_a', status: 'ai_rejected', reject_reason: 'low_score', count: 5 },
      { source_account: 'A', source_id: 'src_a', status: 'ai_rejected', reject_reason: 'duplicate_topic', count: 2 }, // pre-AI dup
    ];
    const pub = [{ source_account: 'A', source_id: 'src_a', count: 2 }];
    const out = shapeQueryYield(items, pub);
    const a = out.find(r => r.sourceAccount === 'A')!;
    expect(a.sourceId).toBe('src_a');
    expect(a.candidates).toBe(8);     // 3 + 5 (duplicates excluded from candidates)
    expect(a.duplicates).toBe(2);
    expect(a.aiRejected).toBe(5);
    expect(a.published).toBe(2);
    expect(a.rejectRate).toBe(0.63);  // 5/8
    expect(a.duplicateRate).toBe(0.2); // 2/(8+2)
    expect(a.publishYield).toBe(0.25); // 2/8
  });
  it('does not double-count ai_rejected rows in query yield', () => {
    const out = shapeQueryYield(
      [
        { source_account: 'A', source_id: 'src_a', status: 'ai_selected', reject_reason: null, count: 3 },
        { source_account: 'A', source_id: 'src_a', status: 'ai_rejected', reject_reason: 'low_score', count: 5 },
        { source_account: 'A', source_id: 'src_a', status: 'ai_rejected', reject_reason: 'duplicate_topic', count: 2 },
      ],
      [{ source_account: 'A', source_id: 'src_a', count: 2 }],
    );
    const a = out.find(r => r.sourceAccount === 'A' && r.sourceId === 'src_a')!;
    expect(a.candidates).toBe(8);
    expect(a.duplicates).toBe(2);
    expect(a.aiRejected).toBe(5); // exactly once, not 10
    expect(a.rejectRate).toBe(0.63);
  });
});

describe('queue-quality steer (pure)', () => {
  const cfg = { minUniqueSourcesNext6h: 2, maxSourceShareNext24h: 0.4, minUniqueFingerprintsNext6h: 2 };
  it('steers when concentrated, not when diverse', () => {
    expect(decideQualitySteer({ scheduledNext6h: 4, uniqueSourcesNext6h: 1, uniqueFingerprintsNext6h: 3, maxSourceShareNext24h: 0.2 }, cfg)).toBe(true);
    expect(decideQualitySteer({ scheduledNext6h: 4, uniqueSourcesNext6h: 3, uniqueFingerprintsNext6h: 1, maxSourceShareNext24h: 0.2 }, cfg)).toBe(true);
    expect(decideQualitySteer({ scheduledNext6h: 4, uniqueSourcesNext6h: 3, uniqueFingerprintsNext6h: 3, maxSourceShareNext24h: 0.8 }, cfg)).toBe(true);
    expect(decideQualitySteer({ scheduledNext6h: 4, uniqueSourcesNext6h: 3, uniqueFingerprintsNext6h: 3, maxSourceShareNext24h: 0.2 }, cfg)).toBe(false);
    expect(decideQualitySteer({ scheduledNext6h: 0, uniqueSourcesNext6h: 0, uniqueFingerprintsNext6h: 0, maxSourceShareNext24h: 0 }, cfg)).toBe(false); // empty → starvation handles it
  });
});

describe('AI cost by source (pure)', () => {
  it('aggregates scoring/translation calls + tokens and tokens-per-published', () => {
    const attr = [
      { source_account: 'A', source_id: 'src_a', purpose: 'scoring', input_tokens: 100, output_tokens: 20 },
      { source_account: 'A', source_id: 'src_a', purpose: 'scoring', input_tokens: 100, output_tokens: 20 },
      { source_account: 'A', source_id: 'src_a', purpose: 'translation', input_tokens: 50, output_tokens: 50 },
      { source_account: 'B', source_id: 'src_b', purpose: 'scoring', input_tokens: 80, output_tokens: 10 },
    ];
    const pub = [{ source_account: 'A', source_id: 'src_a', count: 2 }];
    const out = shapeAiCostBySource(attr, pub);
    const a = out.find(r => r.sourceAccount === 'A')!;
    expect(a.scoringCalls).toBe(2);
    expect(a.translationCalls).toBe(1);
    expect(a.totalTokens).toBe(100 + 20 + 100 + 20 + 50 + 50);
    expect(a.tokensPerPublished).toBe(Math.round(a.totalTokens / 2));
    expect(out[0].sourceAccount).toBe('A'); // sorted by tokens desc
  });

  it('keeps the SAME account split across different source_id buckets (must-fix #1)', () => {
    const attr = [
      { source_account: 'CoinDesk', source_id: 'src_news', purpose: 'scoring', input_tokens: 100, output_tokens: 0 },
      { source_account: 'CoinDesk', source_id: 'src_market', purpose: 'scoring', input_tokens: 300, output_tokens: 0 },
    ];
    const out = shapeAiCostBySource(attr, []);
    expect(out).toHaveLength(2); // two buckets, not merged into one CoinDesk row
    const news = out.find(r => r.sourceId === 'src_news')!;
    const market = out.find(r => r.sourceId === 'src_market')!;
    expect(news.totalTokens).toBe(100);
    expect(market.totalTokens).toBe(300);
  });
});

describe('story_intelligence_events retention cleanup', () => {
  function dbMock(opts: { lastCleanup?: string | null; tableMissing?: boolean }) {
    const calls: string[] = [];
    const prepare = vi.fn((sql: string) => {
      const n = sql.replace(/\s+/g, ' ');
      calls.push(n);
      return {
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (/SELECT value FROM settings/i.test(n)) return opts.lastCleanup ? { value: opts.lastCleanup } : null;
            return null;
          }),
          run: vi.fn(async () => {
            if (opts.tableMissing && /DELETE FROM story_intelligence_events/i.test(n)) throw new Error('no such table: story_intelligence_events');
            return { meta: { changes: 3 } };
          }),
        })),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      };
    });
    return { prepare, calls };
  }

  it('no-op when story intelligence is disabled', async () => {
    const db = dbMock({});
    const res = await cleanupStoryIntelligenceEvents({ DB: { prepare: db.prepare } } as any);
    expect(res).toEqual({ ran: false, deleted: 0 });
    expect(db.calls.length).toBe(0);
  });

  it('skips when it ran within the last ~20h', async () => {
    const db = dbMock({ lastCleanup: new Date(Date.now() - 60 * 60 * 1000).toISOString() }); // 1h ago
    const res = await cleanupStoryIntelligenceEvents({ DB: { prepare: db.prepare }, STORY_INTELLIGENCE_ENABLED: 'true' } as any);
    expect(res.ran).toBe(false);
    expect(db.calls.some(c => /DELETE FROM story_intelligence_events/i.test(c))).toBe(false);
  });

  it('deletes old rows when due and records the marker', async () => {
    const db = dbMock({ lastCleanup: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() }); // 30h ago
    const res = await cleanupStoryIntelligenceEvents({ DB: { prepare: db.prepare }, STORY_INTELLIGENCE_ENABLED: 'true', STORY_INTELLIGENCE_RETENTION_DAYS: '30' } as any);
    expect(res.ran).toBe(true);
    expect(res.deleted).toBe(3);
    expect(db.calls.some(c => /DELETE FROM story_intelligence_events/i.test(c))).toBe(true);
    expect(db.calls.some(c => /INSERT INTO settings/i.test(c))).toBe(true);
  });

  it('is a no-op (no throw) when the table is missing', async () => {
    const db = dbMock({ lastCleanup: null, tableMissing: true });
    const res = await cleanupStoryIntelligenceEvents({ DB: { prepare: db.prepare }, STORY_INTELLIGENCE_ENABLED: 'true' } as any);
    expect(res).toEqual({ ran: false, deleted: 0 });
  });

  it('retention days default + override', () => {
    expect(getStoryIntelligenceRetentionDays({} as any)).toBe(30);
    expect(getStoryIntelligenceRetentionDays({ STORY_INTELLIGENCE_RETENTION_DAYS: '7' } as any)).toBe(7);
    expect(getStoryIntelligenceRetentionDays({ STORY_INTELLIGENCE_RETENTION_DAYS: 'bad' } as any)).toBe(30);
  });
});

describe('story intelligence reject gating (observe-only is a real safety gate)', () => {
  it('does not reject when observe-only is true even if reject flag is true', () => {
    const env = {
      STORY_INTELLIGENCE_ENABLED: 'true',
      STORY_INTELLIGENCE_OBSERVE_ONLY: 'true',
      STORY_INTELLIGENCE_REJECT_ENABLED: 'true',
    } as any;
    expect(isStoryIntelligenceRejectActive(env)).toBe(false);
  });

  it('rejects only when enabled, observe-only false, and reject enabled', () => {
    const env = {
      STORY_INTELLIGENCE_ENABLED: 'true',
      STORY_INTELLIGENCE_OBSERVE_ONLY: 'false',
      STORY_INTELLIGENCE_REJECT_ENABLED: 'true',
    } as any;
    expect(isStoryIntelligenceRejectActive(env)).toBe(true);
  });

  it('observe-only defaults to true (reject inert when unset)', () => {
    // OBSERVE_ONLY omitted → treated as true → no reject even with reject flag on
    const env = {
      STORY_INTELLIGENCE_ENABLED: 'true',
      STORY_INTELLIGENCE_REJECT_ENABLED: 'true',
    } as any;
    expect(isStoryIntelligenceRejectActive(env)).toBe(false);
  });

  it('stays off when the feature itself is disabled', () => {
    const env = {
      STORY_INTELLIGENCE_ENABLED: 'false',
      STORY_INTELLIGENCE_OBSERVE_ONLY: 'false',
      STORY_INTELLIGENCE_REJECT_ENABLED: 'true',
    } as any;
    expect(isStoryIntelligenceRejectActive(env)).toBe(false);
  });
});
