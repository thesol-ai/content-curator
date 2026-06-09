// ══════════════════════════════════════════════════════════════
// services/fair-source-picker.ts
// Pure candidate batch selection helpers for AI backlog drain.
//
// Phase 3 keeps this behavior behind AI_FAIR_SOURCE_PICKER_ENABLED.
// When disabled, the backlog drain keeps FIFO/priority order unchanged.
// ══════════════════════════════════════════════════════════════

import type { AICandidateRow } from '../types';

export interface FairSourcePickerStats {
  enabled: boolean;
  inputCount: number;
  outputCount: number;
  accountCount: number;
  unknownAccountCount: number;
  selectedByAccount: Record<string, number>;
}

export interface CandidateBatchSelection {
  selected: AICandidateRow[];
  stats: FairSourcePickerStats;
}

const UNKNOWN_ACCOUNT = '__unknown__';

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
    ? selectRoundRobinBySourceAccount(candidates, safeLimit)
    : candidates.slice(0, safeLimit);

  return buildSelection(selected, candidates, fairSourcePickerEnabled);
}

export function selectRoundRobinBySourceAccount(candidates: AICandidateRow[], limit: number): AICandidateRow[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (safeLimit <= 0) return [];
  if (candidates.length <= safeLimit) return candidates.slice();

  const groups = new Map<string, AICandidateRow[]>();
  const accountOrder: string[] = [];

  for (const candidate of candidates) {
    const account = accountKey(candidate);
    if (!groups.has(account)) {
      groups.set(account, []);
      accountOrder.push(account);
    }
    groups.get(account)!.push(candidate);
  }

  if (accountOrder.length <= 1) return candidates.slice(0, safeLimit);

  const output: AICandidateRow[] = [];
  let madeProgress = true;

  while (output.length < safeLimit && madeProgress) {
    madeProgress = false;
    for (const account of accountOrder) {
      if (output.length >= safeLimit) break;
      const group = groups.get(account)!;
      const next = group.shift();
      if (next) {
        output.push(next);
        madeProgress = true;
      }
    }
  }

  return output;
}

export function accountKey(candidate: AICandidateRow): string {
  const sourceAccount = String(candidate.source_account ?? '').trim();
  return sourceAccount.length > 0 ? sourceAccount.toLowerCase() : UNKNOWN_ACCOUNT;
}

function buildSelection(
  selected: AICandidateRow[],
  input: AICandidateRow[],
  enabled: boolean,
): CandidateBatchSelection {
  const inputAccounts = new Set<string>();
  let unknownAccountCount = 0;
  for (const row of input) {
    const key = accountKey(row);
    inputAccounts.add(key);
    if (key === UNKNOWN_ACCOUNT) unknownAccountCount++;
  }

  const selectedByAccount: Record<string, number> = {};
  for (const row of selected) {
    const key = accountKey(row);
    selectedByAccount[key] = (selectedByAccount[key] ?? 0) + 1;
  }

  return {
    selected,
    stats: {
      enabled,
      inputCount: input.length,
      outputCount: selected.length,
      accountCount: inputAccounts.size,
      unknownAccountCount,
      selectedByAccount,
    },
  };
}
