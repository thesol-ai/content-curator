// ══════════════════════════════════════════════════════════════
// services/story-intelligence.ts   (Phase 6K — OBSERVE ONLY)
//
// Root cause of theme/story repeats: ~41% of topic_fingerprints are unstable,
// so the same story arriving from several sources with different wording is
// treated as distinct news. This module lays the groundwork to fix that with a
// *structured* story key derived from {primary_entities, event_type,
// canonical_date} the scoring model can emit.
//
// SAFETY: everything here is observe-only and flag-gated.
//   - STORY_INTELLIGENCE_ENABLED=false  → scoring prompt unchanged, no logging.
//   - When enabled it only ASKS the model for extra fields and LOGS a derived
//     story_key. It NEVER rejects on story_key in this phase (that activation
//     is a later, separately-flagged step once the key proves stable).
// The stability report below works today from existing data (no new columns).
// ══════════════════════════════════════════════════════════════

import type { Env } from '../types';

export interface StoryFields {
  primaryEntities: string[];
  eventType: string;
  canonicalDate: string;
}

export function isStoryIntelligenceEnabled(env: Env): boolean {
  return String((env as any).STORY_INTELLIGENCE_ENABLED ?? '').toLowerCase() === 'true';
}

/** When true (default), a derived story_key is only logged, never used to reject. */
export function isStoryIntelligenceObserveOnly(env: Env): boolean {
  const raw = String((env as any).STORY_INTELLIGENCE_OBSERVE_ONLY ?? '').toLowerCase();
  return raw !== 'false'; // default true
}

/** Active de-dup on story_key. Default OFF. Only meaningful when ENABLED too. */
export function isStoryIntelligenceRejectEnabled(env: Env): boolean {
  return String((env as any).STORY_INTELLIGENCE_REJECT_ENABLED ?? '').toLowerCase() === 'true';
}

/**
 * The ONLY predicate that should gate a real story_key rejection. Rejection
 * requires the full two-step opt-in: feature enabled, reject enabled, AND
 * observe-only explicitly turned off. While OBSERVE_ONLY is true (the default)
 * this returns false even if REJECT_ENABLED was flipped on — so OBSERVE_ONLY
 * acts as a genuine emergency "log but never reject" kill-switch.
 */
export function isStoryIntelligenceRejectActive(env: Env): boolean {
  return isStoryIntelligenceEnabled(env)
    && isStoryIntelligenceRejectEnabled(env)
    && !isStoryIntelligenceObserveOnly(env);
}

export function getStoryIntelligenceWindowHours(env: Env): number {
  const n = parseInt(String((env as any).STORY_INTELLIGENCE_WINDOW_HOURS ?? '48'), 10);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

export function isStoryFollowupAllowEnabled(env: Env): boolean {
  const raw = String((env as any).STORY_INTELLIGENCE_FOLLOWUP_ALLOW_ENABLED ?? '').toLowerCase();
  return raw !== 'false'; // default true
}

// Follow-up event types that are materially new developments and must NOT be
// blocked even when an earlier story with the same key was published.
const FOLLOWUP_EVENT_TYPES = new Set([
  'security_recovery', 'lawsuit_update', 'etf_approval', 'etf_decision',
  'protocol_fix', 'exploit_update', 'regulatory_decision', 'court_ruling',
  'settlement', 'verdict', 'resolution', 'recovery',
]);

/** Pure: is this event_type a materially-new follow-up we should let through? */
export function isFollowUpEventType(eventType: unknown): boolean {
  const e = normalizeEventType(eventType);
  if (FOLLOWUP_EVENT_TYPES.has(e)) return true;
  // also treat any *_update / *_decision / *_recovery as follow-up
  return /(_update|_decision|_recovery|_ruling)$/.test(e);
}

/**
 * Pure decision: should we reject this item as a story-key repeat?
 * rejectEnabled + a prior key in window + (followups disabled OR not a followup).
 */
export function shouldRejectByStoryKey(args: {
  rejectEnabled: boolean;
  storyKeySeenInWindow: boolean;
  eventType: string | null | undefined;
  followupAllowEnabled: boolean;
}): boolean {
  if (!args.rejectEnabled || !args.storyKeySeenInWindow) return false;
  if (args.followupAllowEnabled && isFollowUpEventType(args.eventType)) return false;
  return true;
}


export interface SemanticStoryInput {
  storyKey?: string | null;
  fields?: StoryFields | null;
  topicFingerprint?: string | null;
  eventType?: string | null;
  text?: string | null;
}

export interface SemanticStoryRow {
  story_key: string | null;
  event_type: string | null;
  canonical_date: string | null;
  primary_entities_json: string | null;
  topic_fingerprint: string | null;
  discovery_text?: string | null;
}

interface SemanticStorySignature {
  tokens: Set<string>;
  /** Named entities/products/protocols extracted from story fields and story_key. */
  anchorTokens: Set<string>;
  strongTokens: Set<string>;
  actionTokens: Set<string>;
  materialNumbers: Set<string>;
  lexicalTokens: Set<string>;
  eventFamily: string;
  canonicalDate: string | null;
}

const GENERIC_SEMANTIC_TOKENS = new Set([
  'crypto', 'cryptocurrency', 'blockchain', 'web3', 'defi',
  'news', 'update', 'latest', 'new', 'today',
  'us', 'uk', 'usd', 'eur', 'million', 'billion',
  'protocol', 'network', 'market', 'markets',
  'regulation', 'regulatory', 'security',
]);

const ACTION_SEMANTIC_TOKENS = new Set([
  'aml', 'kyc', 'customer', 'identification', 'compliance',
  'clipper', 'clipboard', 'malware', 'stealer',
  'exploit', 'hack', 'drain', 'drained', 'incident', 'bridge',
  'filing', 'files', 'application', 'applications', 'dividend', 'dividends',
  'funding', 'crisis', 'departure', 'departures', 'leadership',
  'reserve', 'reserves', 'cash', 'privacy', 'coin', 'coins',
]);

const WEAK_SEMANTIC_ANCHOR_TOKENS = new Set([
  'crypto', 'cryptocurrency', 'blockchain', 'web3', 'defi',
  'news', 'update', 'latest', 'new', 'today',
  'protocol', 'network', 'market', 'markets',
  'regulation', 'regulatory', 'security',
  'us', 'uk', 'usd', 'eur',
]);

const BROAD_SECURITY_CONTEXT_ANCHORS = new Set([
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
  'bnb', 'bnbchain', 'bnb_chain', 'base', 'arbitrum',
  'optimism', 'polygon', 'avalanche', 'chain',
]);

function canonicalSemanticToken(raw: unknown): string | null {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/&amp;/g, 'and')
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!s || s.length < 2) return null;

  const aliases: Record<string, string> = {
    european_union: 'eu',
    msftsecurity: 'microsoft',
    microsoft_security: 'microsoft',
    jared_from_subway: 'jaredfromsubway',
    jared_from_subway_mev_bot_drain: 'jaredfromsubway',
    secret: 'secret_network',
    secret_network_connections: 'secret_network',
    franklin: 'franklin_templeton',
    franklin_templeton: 'franklin_templeton',
    crypto_clipper: 'crypto_clipper_malware',
    clipboard_stealer: 'crypto_clipper_malware',
    wallet_hijack: 'crypto_clipper_malware',
    security_wallet_drain: 'wallet_drain',
    bridge_incident: 'exploit',
    security_malware_alert: 'malware',
    security_threat: 'malware',
    etf_product: 'etf',
    institutional_etf_product: 'etf',
    etf_filing: 'etf',
    stablecoin_regulation: 'regulation',
    protocol_governance: 'governance',
    governance_leadership_change: 'governance',
  };

  return aliases[s] ?? s;
}

function addToken(out: Set<string>, raw: unknown): void {
  const token = canonicalSemanticToken(raw);
  if (!token) return;
  out.add(token);

  if (token.includes('_')) {
    for (const part of token.split('_')) {
      const p = canonicalSemanticToken(part);
      if (p) out.add(p);
    }
  }
}

function addAnchorToken(out: Set<string>, raw: unknown): void {
  const token = canonicalSemanticToken(raw);
  if (!token || WEAK_SEMANTIC_ANCHOR_TOKENS.has(token)) return;
  out.add(token);
}

function tokenizeSemantic(value: unknown): Set<string> {
  const out = new Set<string>();
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/[$]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) return out;

  if (normalized.includes('jared_from_subway')) out.add('jaredfromsubway');
  if (normalized.includes('secret_network')) out.add('secret_network');
  if (normalized.includes('franklin_templeton')) out.add('franklin_templeton');
  if (normalized.includes('ethereum_foundation')) out.add('ethereum_foundation');
  if (normalized.includes('genius_act')) out.add('genius_act');

  addToken(out, normalized);
  for (const part of normalized.split('_')) addToken(out, part);

  return out;
}

const LEXICAL_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto',
  'have', 'has', 'had', 'will', 'would', 'could', 'should', 'said',
  'says', 'after', 'before', 'about', 'over', 'under', 'more', 'less',
  'than', 'then', 'they', 'their', 'them', 'its', 'his', 'her', 'our',
  'your', 'are', 'was', 'were', 'been', 'being', 'also', 'now',
  'approximately', 'roughly', 'worth', 'including', 'according',
  'report', 'reported', 'reports', 'new', 'latest', 'update', 'alert',
]);

function tokenizeLexical(value: unknown): Set<string> {
  const out = new Set<string>();
  const raw = String(value ?? '').toLowerCase().replace(/&amp;/g, 'and');
  if (!raw.trim()) return out;

  for (const part of raw.split(/[^\p{L}\p{N}_-]+/u)) {
    const token = canonicalSemanticToken(part);
    if (!token || token.length < 4) continue;
    if (LEXICAL_STOP_WORDS.has(token)) continue;
    if (GENERIC_SEMANTIC_TOKENS.has(token)) continue;
    out.add(token);
  }

  return out;
}

function normalizeNumberUnit(unitRaw: string | undefined): string {
  const unit = String(unitRaw ?? '').toLowerCase();
  if (['m', 'mn', 'million'].includes(unit)) return 'm';
  if (['b', 'bn', 'billion'].includes(unit)) return 'b';
  if (['k', 'thousand'].includes(unit)) return 'k';
  if (['t', 'trillion'].includes(unit)) return 't';
  if (['%', 'percent'].includes(unit)) return 'pct';
  if (['btc', 'eth', 'usdc', 'usdt', 'weth'].includes(unit)) return unit;
  return '';
}

function extractMaterialNumberTokens(value: unknown): Set<string> {
  const out = new Set<string>();
  const text = String(value ?? '').toLowerCase().replace(/,/g, '');
  if (!text.trim()) return out;

  const re = /(?:[$€£]\s*)?(\d+(?:\.\d+)?)\s*(k|m|mn|b|bn|t|million|billion|thousand|trillion|%|percent|btc|eth|weth|usdc|usdt)?/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const n = Number(match[1]);
    if (!Number.isFinite(n)) continue;

    const unit = normalizeNumberUnit(match[2]);
    if (!unit) {
      if (n >= 1900 && n <= 2100) continue;
      if (n < 1000000) continue;
      out.add(`num:${Math.round(n)}`);
      continue;
    }

    // Ignore plain years even if punctuation around them confused the regex.
    if (!match[2] && n >= 1900 && n <= 2100) continue;

    const rounded = Math.round(n * 100) / 100;
    out.add(`num:${rounded}:${unit}`);
  }

  return out;
}

function combinedTextForSemantic(input: SemanticStoryInput): string {
  return [
    input.storyKey ?? '',
    input.topicFingerprint ?? '',
    input.fields?.primaryEntities?.join(' ') ?? '',
    input.fields?.eventType ?? '',
    input.text ?? '',
  ].join(' ');
}

function eventFamilyFromTokens(tokens: Set<string>, eventType?: string | null): string {
  const joined = `${eventType ?? ''} ${Array.from(tokens).join(' ')}`.toLowerCase();

  if (/(exploit|hack|drain|drained|malware|clipper|stealer|wallet_drain|bridge_incident|security_incident|incident)/.test(joined)) {
    return 'security_incident';
  }
  if (/(aml|kyc|mica|cftc|sec|regulation|regulatory|compliance|cbdc|genius_act|privacy_coins)/.test(joined)) {
    return 'regulation';
  }
  if (/(etf|filing|application|applications|fund|dividend|dividends|reserve)/.test(joined)) {
    return 'etf_product';
  }
  if (/(governance|foundation|funding|leadership|departure|departures|core_development)/.test(joined)) {
    return 'governance';
  }
  if (/(price|drawdown|options|expiry|miner|selling|accumulation|purchase)/.test(joined)) {
    return 'market_activity';
  }
  return normalizeEventType(eventType ?? 'unknown');
}

function parseStoryKeyParts(storyKey?: string | null): { entities: string[]; eventType: string | null; date: string | null } {
  const parts = String(storyKey ?? '').split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { entities: [], eventType: null, date: null };

  let date: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] ?? '')) {
    date = parts.pop() ?? null;
  }

  const eventType = parts.length > 0 ? parts.pop() ?? null : null;
  return { entities: parts, eventType, date };
}

function parsePrimaryEntitiesJson(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(v => String(v)) : [];
  } catch {
    return [];
  }
}

export function buildSemanticStorySignature(input: SemanticStoryInput): SemanticStorySignature {
  const parsed = parseStoryKeyParts(input.storyKey);
  const tokens = new Set<string>();
  const anchorTokens = new Set<string>();

  for (const entity of parsed.entities) {
    addToken(tokens, entity);
    addAnchorToken(anchorTokens, entity);
  }
  for (const entity of input.fields?.primaryEntities ?? []) {
    addToken(tokens, entity);
    addAnchorToken(anchorTokens, entity);
  }
  for (const token of tokenizeSemantic(input.topicFingerprint)) tokens.add(token);
  for (const token of tokenizeSemantic(parsed.eventType)) tokens.add(token);
  for (const token of tokenizeSemantic(input.fields?.eventType ?? input.eventType)) tokens.add(token);

  const lexicalTokens = tokenizeLexical(input.text);
  const materialNumbers = extractMaterialNumberTokens(combinedTextForSemantic(input));

  const eventType = input.fields?.eventType ?? input.eventType ?? parsed.eventType;
  const eventFamily = eventFamilyFromTokens(tokens, eventType);
  const canonicalDate = normalizeCanonicalDate(input.fields?.canonicalDate ?? parsed.date) || null;

  const strongTokens = new Set<string>();
  const actionTokens = new Set<string>();
  for (const token of tokens) {
    if (!GENERIC_SEMANTIC_TOKENS.has(token) && token.length >= 3) strongTokens.add(token);
    if (ACTION_SEMANTIC_TOKENS.has(token)) actionTokens.add(token);
  }

  return { tokens, anchorTokens, strongTokens, actionTokens, materialNumbers, lexicalTokens, eventFamily, canonicalDate };
}

function intersectionCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const value of a) if (b.has(value)) n++;
  return n;
}

function hasAnyIntersection(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function hasSpecificSharedAnchor(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (!b.has(value)) continue;
    if (BROAD_SECURITY_CONTEXT_ANCHORS.has(value)) continue;
    if (WEAK_SEMANTIC_ANCHOR_TOKENS.has(value)) continue;
    return true;
  }
  return false;
}

function hasLongSpecificSharedAnchor(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (!b.has(value)) continue;
    if (BROAD_SECURITY_CONTEXT_ANCHORS.has(value)) continue;
    if (WEAK_SEMANTIC_ANCHOR_TOKENS.has(value)) continue;
    if (value.length >= 10) return true;
  }
  return false;
}

function differenceCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const value of a) if (!b.has(value)) n++;
  return n;
}

function datesAreCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) <= 24 * 60 * 60 * 1000;
}

export function shouldRejectBySemanticStorySimilarity(args: {
  rejectEnabled: boolean;
  current: SemanticStoryInput;
  prior: SemanticStoryInput;
  followupAllowEnabled: boolean;
}): boolean {
  if (!args.rejectEnabled) return false;
  if (args.followupAllowEnabled && isFollowUpEventType(args.current.fields?.eventType ?? args.current.eventType)) return false;

  const current = buildSemanticStorySignature(args.current);
  const prior = buildSemanticStorySignature(args.prior);

  if (current.eventFamily !== prior.eventFamily) return false;

  const dateCompatible = datesAreCompatible(current.canonicalDate, prior.canonicalDate);
  if (!dateCompatible && current.eventFamily !== 'security_incident') return false;

  const sharedStrong = intersectionCount(current.strongTokens, prior.strongTokens);
  const sharedAction = intersectionCount(current.actionTokens, prior.actionTokens);
  const sharedAnchors = intersectionCount(current.anchorTokens, prior.anchorTokens);
  const sharedNumbers = intersectionCount(current.materialNumbers, prior.materialNumbers);
  const sharedLexical = intersectionCount(current.lexicalTokens, prior.lexicalTokens);
  const currentNewAnchors = differenceCount(current.anchorTokens, prior.anchorTokens);
  const priorNewAnchors = differenceCount(prior.anchorTokens, current.anchorTokens);

  // Same named actors/products/protocols. This is generic and does not depend on
  // knowing the topic in advance.
  if (sharedAnchors >= 3) return true;

  // Same material number plus a specific shared actor is a strong duplicate signal.
  // For security stories, broad chain anchors like Ethereum/Solana alone are not enough.
  if (
    sharedNumbers > 0
    && (
      hasSpecificSharedAnchor(current.anchorTokens, prior.anchorTokens)
      || (current.eventFamily !== 'security_incident' && sharedAnchors >= 1)
    )
  ) return true;

  // Security stories are often rewritten with different event labels. Block on
  // a shared *specific* actor/protocol, not on broad chain context alone.
  if (current.eventFamily === 'security_incident') {
    const hasSpecificShared = hasSpecificSharedAnchor(current.anchorTokens, prior.anchorTokens);

    if (!hasSpecificShared) {
      return false;
    }

    if (sharedAnchors >= 2) return true;
    if (sharedNumbers > 0) return true;
    if (hasLongSpecificSharedAnchor(current.anchorTokens, prior.anchorTokens)) return true;
    if (sharedAction > 0) return true;
    if (sharedLexical >= 3) return true;
  }

  // ETF/product/governance repeats should block when the named anchors overlap,
  // except when each side introduces a different major actor.
  if (current.eventFamily === 'etf_product' || current.eventFamily === 'governance') {
    if (sharedAnchors >= 2 && !(currentNewAnchors > 0 && priorNewAnchors > 0)) return true;
    if (sharedAnchors >= 1 && sharedLexical >= 4) return true;
  }

  // Regulation is noisy. Same law + same regulated subject blocks; a new company
  // operating under the same law should survive.
  if (current.eventFamily === 'regulation') {
    if (sharedAnchors >= 3 && !(currentNewAnchors > 0 && priorNewAnchors > 0)) return true;
    if (sharedAnchors >= 2 && sharedAction > 0 && currentNewAnchors === 0) return true;
    if (
      current.anchorTokens.has('eu')
      && prior.anchorTokens.has('eu')
      && hasAnyIntersection(current.actionTokens, prior.actionTokens)
      && sharedLexical >= 2
    ) {
      return true;
    }
  }

  // Generic fallback: high lexical overlap plus an anchor means another source is
  // likely retelling the same story with different wording.
  if (sharedAnchors >= 1 && sharedLexical >= 5) return true;

  // High structured overlap with no new current actor is probably the same story.
  if (sharedStrong >= 3 && currentNewAnchors === 0) return true;

  return false;
}

/** Was a semantically similar story already queued/published for the channel within window? */
export async function similarStorySeenInWindow(
  env: Env,
  args: {
    categoryId: string;
    channelId?: string | null;
    storyKey?: string | null;
    fields?: StoryFields | null;
    topicFingerprint?: string | null;
    eventType?: string | null;
    text?: string | null;
    windowHours: number;
    followupAllowEnabled: boolean;
  },
): Promise<boolean> {
  if (!env.DB) return false;
  if (!args.storyKey && !args.topicFingerprint) return false;

  try {
    const res = await env.DB.prepare(`
      SELECT
        sie.story_key,
        sie.event_type,
        sie.canonical_date,
        sie.primary_entities_json,
        sie.topic_fingerprint,
        d.text AS discovery_text
      FROM story_intelligence_events sie
      LEFT JOIN discovery_items d ON d.id = sie.discovery_item_id
      WHERE sie.category_id = ?
        AND (sie.channel_id = ? OR ? IS NULL)
        AND sie.status IN ('queued','published')
        AND sie.created_at > datetime('now','-' || ? || ' hours')
      ORDER BY sie.created_at DESC
      LIMIT 250
    `).bind(args.categoryId, args.channelId ?? null, args.channelId ?? null, String(args.windowHours))
      .all<SemanticStoryRow>();

    const current: SemanticStoryInput = {
      storyKey: args.storyKey ?? null,
      fields: args.fields ?? null,
      topicFingerprint: args.topicFingerprint ?? null,
      eventType: args.eventType ?? null,
      text: args.text ?? null,
    };

    for (const row of res.results ?? []) {
      const priorFields: StoryFields | null = {
        primaryEntities: parsePrimaryEntitiesJson(row.primary_entities_json),
        eventType: normalizeEventType(row.event_type),
        canonicalDate: normalizeCanonicalDate(row.canonical_date),
      };

      if (shouldRejectBySemanticStorySimilarity({
        rejectEnabled: true,
        current,
        prior: {
          storyKey: row.story_key,
          fields: priorFields,
          topicFingerprint: row.topic_fingerprint,
          eventType: row.event_type,
          text: row.discovery_text ?? null,
        },
        followupAllowEnabled: args.followupAllowEnabled,
      })) {
        return true;
      }
    }
  } catch (err) {
    console.warn('[StoryIntel] similarStorySeenInWindow skipped:', err instanceof Error ? err.message : String(err));
  }

  return false;
}

// ── Pure helpers (unit-tested) ────────────────────────────────

export function normalizeEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const e = String(raw ?? '')
      .toLowerCase()
      .replace(/^\$/, '')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim()
      .replace(/\s+/g, '_');
    if (e.length >= 2 && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
    if (out.length >= 3) break; // cap at the 3 most salient entities
  }
  return out.sort();
}

function normalizeEventType(value: unknown): string {
  const e = String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '_');
  return e.slice(0, 40) || 'unknown';
}

function normalizeCanonicalDate(value: unknown): string {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Tolerantly read the structured fields from a raw model item (may be absent). */
export function parseStoryFields(raw: any): StoryFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const primaryEntities = normalizeEntities(raw.primary_entities);
  const eventType = normalizeEventType(raw.event_type);
  const canonicalDate = normalizeCanonicalDate(raw.canonical_date);
  if (primaryEntities.length === 0 && eventType === 'unknown') return null;
  return { primaryEntities, eventType, canonicalDate };
}

/**
 * Deterministic story key: sorted entities + event_type + date.
 * e.g. "monero|tether|zachxbt|security_laundering|2026-06-13".
 * Returns null when there is not enough signal to be meaningful.
 */
export function buildStoryKey(fields: StoryFields | null): string | null {
  if (!fields) return null;
  const { primaryEntities, eventType, canonicalDate } = fields;
  if (primaryEntities.length === 0) return null;
  const parts = [primaryEntities.join('|'), eventType];
  if (canonicalDate) parts.push(canonicalDate);
  return parts.join('|');
}

// ── Observe report (works today from discovery_items.topic_fingerprint) ──

export interface StoryStabilityReport {
  generatedAt: string;
  categoryId: string | null;
  windowHours: number;
  totalWithFingerprint: number;
  unstableLikeCount: number;
  unstablePct: number;
  repeatedFingerprints: Array<{ fingerprint: string; count: number }>;
  storyKey: StoryKeyMetrics | null; // populated once 6K has recorded events
}

const UNSTABLE_PREFIXES = ['ns-', 'fp-', 'err-', 'budget-'];

/** Pure: classify a fingerprint as unstable (auto-generated fallback slug). */
export function isUnstableFingerprint(fp: unknown): boolean {
  const s = String(fp ?? '').trim();
  if (!s) return true;
  return UNSTABLE_PREFIXES.some(p => s.startsWith(p));
}

export function summarizeStability(
  rows: Array<{ topic_fingerprint: string | null }>,
): { total: number; unstable: number; pct: number } {
  const total = rows.length;
  const unstable = rows.reduce((n, r) => n + (isUnstableFingerprint(r.topic_fingerprint) ? 1 : 0), 0);
  const pct = total > 0 ? Math.round((unstable / total) * 1000) / 10 : 0;
  return { total, unstable, pct };
}

export async function buildStoryStabilityReport(
  env: Env,
  opts: { categoryId?: string; windowHours?: number } = {},
): Promise<StoryStabilityReport> {
  const windowHours = clampInt(Number(opts.windowHours), 1, 720, 72);
  const categoryId = opts.categoryId && /^[\w-]{1,64}$/.test(opts.categoryId) ? opts.categoryId : null;

  let rows: Array<{ topic_fingerprint: string | null }> = [];
  let repeated: Array<{ fingerprint: string; count: number }> = [];
  if (env.DB) {
    try {
      const res = categoryId
        ? await env.DB.prepare(
            `SELECT topic_fingerprint FROM discovery_items
             WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(categoryId, String(windowHours)).all<{ topic_fingerprint: string | null }>()
        : await env.DB.prepare(
            `SELECT topic_fingerprint FROM discovery_items
             WHERE created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(String(windowHours)).all<{ topic_fingerprint: string | null }>();
      rows = res.results ?? [];

      const rep = categoryId
        ? await env.DB.prepare(
            `SELECT topic_fingerprint AS fp, COUNT(*) AS c FROM discovery_items
             WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')
               AND topic_fingerprint IS NOT NULL
             GROUP BY topic_fingerprint HAVING c > 1 ORDER BY c DESC LIMIT 20`,
          ).bind(categoryId, String(windowHours)).all<{ fp: string; c: number }>()
        : await env.DB.prepare(
            `SELECT topic_fingerprint AS fp, COUNT(*) AS c FROM discovery_items
             WHERE created_at > datetime('now','-' || ? || ' hours')
               AND topic_fingerprint IS NOT NULL
             GROUP BY topic_fingerprint HAVING c > 1 ORDER BY c DESC LIMIT 20`,
          ).bind(String(windowHours)).all<{ fp: string; c: number }>();
      repeated = (rep.results ?? [])
        .filter(r => !isUnstableFingerprint(r.fp))
        .map(r => ({ fingerprint: String(r.fp), count: Number(r.c) || 0 }));
    } catch (err) {
      console.warn('[StoryIntel] stability report skipped:', err instanceof Error ? err.message : String(err));
    }
  }

  const s = summarizeStability(rows);

  // story_key metrics from the queryable table (empty until 6K records events)
  let storyKeyMetrics: StoryKeyMetrics | null = null;
  if (env.DB) {
    try {
      const skRes = categoryId
        ? await env.DB.prepare(
            `SELECT story_key, event_type, status FROM story_intelligence_events
             WHERE category_id=? AND created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(categoryId, String(windowHours)).all<{ story_key: string; event_type: string | null; status: string }>()
        : await env.DB.prepare(
            `SELECT story_key, event_type, status FROM story_intelligence_events
             WHERE created_at > datetime('now','-' || ? || ' hours')`,
          ).bind(String(windowHours)).all<{ story_key: string; event_type: string | null; status: string }>();
      const skRows = skRes.results ?? [];
      if (skRows.length > 0) storyKeyMetrics = shapeStoryKeyMetrics(skRows);
    } catch {
      // table may not exist yet (migration 0019 not applied) → leave null
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    categoryId,
    windowHours,
    totalWithFingerprint: s.total,
    unstableLikeCount: s.unstable,
    unstablePct: s.pct,
    repeatedFingerprints: repeated,
    storyKey: storyKeyMetrics,
  };
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── Queryable store (Phase 6K — needs migration 0019) ─────────────

export interface StoryEventInput {
  categoryId: string;
  channelId?: string | null;
  storyKey: string;
  fields: StoryFields | null;
  topicFingerprint?: string | null;
  sourceId?: string | null;
  sourceAccount?: string | null;
  discoveryItemId?: string | null;
  candidateId?: string | null;
  queueId?: string | null;
  status: string; // 'scored' | 'queued' | 'published' | 'rejected'
}

/** Best-effort insert into story_intelligence_events (no-op if table absent). */
export async function recordStoryEvent(env: Env, input: StoryEventInput): Promise<void> {
  if (!env.DB || !input.storyKey) return;
  try {
    await env.DB.prepare(`
      INSERT INTO story_intelligence_events
        (id, category_id, channel_id, story_key, event_type, canonical_date,
         primary_entities_json, topic_fingerprint, source_id, source_account,
         discovery_item_id, candidate_id, queue_id, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      `si_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      input.categoryId,
      input.channelId ?? null,
      input.storyKey,
      input.fields?.eventType ?? null,
      input.fields?.canonicalDate ?? null,
      input.fields ? JSON.stringify(input.fields.primaryEntities) : null,
      input.topicFingerprint ?? null,
      input.sourceId ?? null,
      input.sourceAccount ?? null,
      input.discoveryItemId ?? null,
      input.candidateId ?? null,
      input.queueId ?? null,
      input.status,
    ).run();
  } catch (err) {
    console.warn('[StoryIntel] recordStoryEvent skipped:', err instanceof Error ? err.message : String(err));
  }
}

/** Was this story_key already published/queued for the channel within window? */
export async function storyKeySeenInWindow(
  env: Env, args: { categoryId: string; channelId?: string | null; storyKey: string; windowHours: number },
): Promise<boolean> {
  if (!env.DB || !args.storyKey) return false;
  try {
    const row = await env.DB.prepare(`
      SELECT 1 AS hit FROM story_intelligence_events
      WHERE category_id = ? AND story_key = ?
        AND (channel_id = ? OR ? IS NULL)
        AND status IN ('queued','published')
        AND created_at > datetime('now','-' || ? || ' hours')
      LIMIT 1
    `).bind(args.categoryId, args.storyKey, args.channelId ?? null, args.channelId ?? null, String(args.windowHours))
      .first<{ hit: number }>();
    return Boolean(row?.hit);
  } catch (err) {
    console.warn('[StoryIntel] storyKeySeenInWindow skipped:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ── Story-key report metrics (Phase 6K item 4) ────────────────────

export interface StoryKeyMetrics {
  storyKeyTotal: number;
  storyKeyUnique: number;
  storyKeyRepeated: number;
  storyKeyPresent: number;
  storyKeyMissing: number;
  missingPct: number;
  topRepeatedStoryKeys: Array<{ storyKey: string; count: number }>;
  wouldBlockCountIfRejectEnabled: number;
}

/** Pure: compute story_key metrics from event rows (status may be 'story_key_missing'). */
export function shapeStoryKeyMetrics(rows: Array<{ story_key: string; event_type: string | null; status?: string }>): StoryKeyMetrics {
  const missing = rows.filter(r => String(r.status ?? '') === 'story_key_missing' || String(r.story_key ?? '') === '__missing__');
  const present = rows.filter(r => !(String(r.status ?? '') === 'story_key_missing' || String(r.story_key ?? '') === '__missing__'));
  const counts = new Map<string, number>();
  for (const r of present) {
    const k = String(r.story_key ?? '');
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  const unique = counts.size;
  let repeated = 0;
  let wouldBlock = 0;
  const seenKey = new Set<string>();
  for (const r of present) {
    const k = String(r.story_key ?? '');
    if (!k) continue;
    if (!seenKey.has(k)) { seenKey.add(k); continue; }
    if (!isFollowUpEventType(r.event_type)) wouldBlock++;
  }
  for (const n of counts.values()) if (n > 1) repeated++;
  const top = Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .map(([storyKey, count]) => ({ storyKey, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const presentCount = present.length;
  const missingCount = missing.length;
  const denom = presentCount + missingCount;
  return {
    storyKeyTotal: total,
    storyKeyUnique: unique,
    storyKeyRepeated: repeated,
    storyKeyPresent: presentCount,
    storyKeyMissing: missingCount,
    missingPct: denom > 0 ? Math.round((missingCount / denom) * 1000) / 10 : 0,
    topRepeatedStoryKeys: top,
    wouldBlockCountIfRejectEnabled: wouldBlock,
  };
}

// ── Retention cleanup for story_intelligence_events (cron, daily-guarded) ──

export function getStoryIntelligenceRetentionDays(env: Env): number {
  const n = parseInt(String((env as any).STORY_INTELLIGENCE_RETENTION_DAYS ?? '30'), 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Delete story_intelligence_events older than the retention window. Runs at most
 * once per ~20h (settings marker) and only when story intelligence is enabled.
 * The dedupe window is at most ~48h, so long-term rows have no value. Best-effort;
 * no-op if the table is missing (migration 0019 not applied) and never throws.
 */
export async function cleanupStoryIntelligenceEvents(env: Env): Promise<{ ran: boolean; deleted: number }> {
  if (!env.DB) return { ran: false, deleted: 0 };
  if (!isStoryIntelligenceEnabled(env)) return { ran: false, deleted: 0 };
  const MARKER = 'story_intelligence_events_last_cleanup';
  try {
    const last = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(MARKER).first<{ value: string }>();
    const lastMs = last?.value ? Date.parse(last.value) : 0;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < 20 * 60 * 60 * 1000) {
      return { ran: false, deleted: 0 }; // ran recently
    }
    const days = getStoryIntelligenceRetentionDays(env);
    const res = await env.DB.prepare(
      `DELETE FROM story_intelligence_events WHERE created_at < datetime('now','-' || ? || ' days')`,
    ).bind(String(days)).run();
    const deleted = Number((res as any)?.meta?.changes ?? 0);
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).bind(MARKER, new Date().toISOString()).run();
    if (deleted > 0) console.log('[StoryIntel] retention cleanup removed', deleted, 'events older than', days, 'days');
    return { ran: true, deleted };
  } catch (err) {
    console.warn('[StoryIntel] cleanup skipped:', err instanceof Error ? err.message : String(err));
    return { ran: false, deleted: 0 };
  }
}
