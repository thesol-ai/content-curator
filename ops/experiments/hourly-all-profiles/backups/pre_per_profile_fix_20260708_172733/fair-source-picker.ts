// ══════════════════════════════════════════════════════════════
// services/fair-source-picker.ts
// Pure candidate batch selection helpers for AI backlog drain.
//
// Phase 6A upgrades the picker from account-only round-robin to fair-fill
// across source/task buckets first, then source accounts inside each bucket.
// This preserves batch volume through backfill instead of hard-capping or
// rejecting dominant accounts. When disabled, backlog drain keeps the existing
// priority/FIFO order unchanged.
// ══════════════════════════════════════════════════════════════

import type { AICandidateRow } from '../types';

export interface FairSourcePickerStats {
  enabled: boolean;
  inputCount: number;
  outputCount: number;
  sourceIdCount: number;
  accountCount: number;
  unknownSourceIdCount: number;
  unknownAccountCount: number;
  selectedBySourceId: Record<string, number>;
  selectedByAccount: Record<string, number>;
  selectedByBucket: Record<string, number>;
}

export interface CandidateBatchSelection {
  selected: AICandidateRow[];
  stats: FairSourcePickerStats;
}

interface SourceGroup {
  sourceId: string;
  accountOrder: string[];
  accounts: Map<string, AICandidateRow[]>;
  accountCursor: number;
  remaining: number;
}

const UNKNOWN_SOURCE_ID = '__unknown_source__';
const UNKNOWN_ACCOUNT = '__unknown_account__';

export function selectCandidateBatchForScoring(
  candidates: AICandidateRow[],
  limit: number,
  fairSourcePickerEnabled: boolean,
): CandidateBatchSelection {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (safeLimit <= 0 || candidates.length === 0) {
    return buildSelection([], candidates, fairSourcePickerEnabled);
  }

  const selected = fairSourcePickerEnabled
    ? selectFairFillBySourceAndAccount(candidates, safeLimit)
    : candidates.slice(0, safeLimit);

  return buildSelection(selected, candidates, fairSourcePickerEnabled);
}

/**
 * Backwards-compatible export name used by older tests/imports.
 * The implementation now balances source/task buckets before accounts.
 */
export function selectRoundRobinBySourceAccount(candidates: AICandidateRow[], limit: number): AICandidateRow[] {
  return selectFairFillBySourceAndAccount(candidates, limit);
}

/**
 * Fair-fill selection that preserves volume.
 *
 * Selection order:
 * 1. Group by source_id. In this codebase source_id is the best available
 *    proxy for task/query bucket, e.g. news_text vs voices_media.
 * 2. Inside each source_id, round-robin source_account/profile.
 * 3. Cycle source_id groups until the batch is full.
 * 4. If minority buckets run out, dominant buckets backfill the batch.
 *
 * There is intentionally no hard cap or rejection here. If only one source has
 * candidates, the batch still fills from that source, so post volume is not
 * reduced merely to make distribution look pretty in a report nobody reads.
 */
export function selectFairFillBySourceAndAccount(candidates: AICandidateRow[], limit: number): AICandidateRow[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (safeLimit <= 0) return [];
  const { sourceOrder, sourceGroups } = buildSourceGroups(candidates);
  if (sourceOrder.length === 0) return [];

  const output: AICandidateRow[] = [];
  let madeProgress = true;

  while (output.length < safeLimit && madeProgress) {
    madeProgress = false;

    for (const sourceId of sourceOrder) {
      if (output.length >= safeLimit) break;
      const group = sourceGroups.get(sourceId);
      if (!group || group.remaining <= 0) continue;

      const next = takeNextFromSourceGroup(group);
      if (next) {
        output.push(next);
        madeProgress = true;
      }
    }
  }

  return output;
}

export function sourceIdKey(candidate: AICandidateRow): string {
  const sourceId = String(candidate.source_id ?? '').trim();
  return sourceId.length > 0 ? sourceId : UNKNOWN_SOURCE_ID;
}

export function accountKey(candidate: AICandidateRow): string {
  const sourceAccount = String(candidate.source_account ?? '').trim();
  return sourceAccount.length > 0 ? sourceAccount.toLowerCase() : UNKNOWN_ACCOUNT;
}

export function sourceAccountBucketKey(candidate: AICandidateRow): string {
  return `${sourceIdKey(candidate)}::${accountKey(candidate)}`;
}

function buildSourceGroups(candidates: AICandidateRow[]): {
  sourceOrder: string[];
  sourceGroups: Map<string, SourceGroup>;
} {
  const sourceGroups = new Map<string, SourceGroup>();
  const sourceOrder: string[] = [];

  for (const candidate of candidates) {
    const sourceId = sourceIdKey(candidate);
    const account = accountKey(candidate);

    let group = sourceGroups.get(sourceId);
    if (!group) {
      group = {
        sourceId,
        accountOrder: [],
        accounts: new Map<string, AICandidateRow[]>(),
        accountCursor: 0,
        remaining: 0,
      };
      sourceGroups.set(sourceId, group);
      sourceOrder.push(sourceId);
    }

    if (!group.accounts.has(account)) {
      group.accounts.set(account, []);
      group.accountOrder.push(account);
    }

    group.accounts.get(account)!.push(candidate);
    group.remaining++;
  }

  return { sourceOrder, sourceGroups };
}

function takeNextFromSourceGroup(group: SourceGroup): AICandidateRow | null {
  if (group.remaining <= 0 || group.accountOrder.length === 0) return null;

  const accountCount = group.accountOrder.length;
  for (let attempt = 0; attempt < accountCount; attempt++) {
    const index = group.accountCursor % accountCount;
    const account = group.accountOrder[index]!;
    group.accountCursor = (group.accountCursor + 1) % accountCount;

    const bucket = group.accounts.get(account);
    const next = bucket?.shift();
    if (next) {
      group.remaining--;
      return next;
    }
  }

  return null;
}

function buildSelection(
  selected: AICandidateRow[],
  input: AICandidateRow[],
  enabled: boolean,
): CandidateBatchSelection {
  const inputSourceIds = new Set<string>();
  const inputAccounts = new Set<string>();
  let unknownSourceIdCount = 0;
  let unknownAccountCount = 0;

  for (const row of input) {
    const source = sourceIdKey(row);
    const account = accountKey(row);
    inputSourceIds.add(source);
    inputAccounts.add(account);
    if (source === UNKNOWN_SOURCE_ID) unknownSourceIdCount++;
    if (account === UNKNOWN_ACCOUNT) unknownAccountCount++;
  }

  return {
    selected,
    stats: {
      enabled,
      inputCount: input.length,
      outputCount: selected.length,
      sourceIdCount: inputSourceIds.size,
      accountCount: inputAccounts.size,
      unknownSourceIdCount,
      unknownAccountCount,
      selectedBySourceId: countBy(selected, sourceIdKey),
      selectedByAccount: countBy(selected, accountKey),
      selectedByBucket: countBy(selected, sourceAccountBucketKey),
    },
  };
}

function countBy(rows: AICandidateRow[], keyFn: (row: AICandidateRow) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
