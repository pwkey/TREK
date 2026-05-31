// [460-fork] Fuzzy-match passenger names against known user + partner accounts.
// Pure function — no I/O, no DB. Caller fetches candidates and threads them in.
//
// Matching strategy (cheap, deterministic):
//   1. Normalise both sides (NFD, strip diacritics, lowercase, punctuation/
//      whitespace collapsed to a single space).
//   2. Exact normalised match on the full name → candidate.
//   3. Token-set match: the passenger's tokens contain every token of at
//      least one candidate alias → candidate.
//   4. Levenshtein ≤ 2 on the full normalised string → candidate.
//   5. Otherwise null.
//
// Candidates list should be ≤ 2 in current usage (user + partner); ambiguity
// resolution picks the single best-scoring match and falls back to null on a
// tie to avoid false positives.

export type PassengerKind = 'user' | 'member';

export interface PassengerMatchCandidate {
  id: number;
  // [460-fork] M11 slice 5: candidates may be user-accounts or named
  // household_members. The matcher returns the kind alongside the id
  // so the route can split results into matched_user_ids and
  // matched_member_ids. Defaults to 'user' for backwards compatibility
  // with the M3-era callers.
  kind?: PassengerKind;
  // One or more aliases per candidate — e.g. username, email local-part,
  // full-name variants. Each is matched independently; the best wins.
  aliases: string[];
}

export interface PassengerMatchResult {
  kind: PassengerKind;
  id: number;
}

export function matchPassengers(
  names: string[],
  candidates: PassengerMatchCandidate[],
): Array<PassengerMatchResult | null> {
  if (!Array.isArray(names) || names.length === 0) return [];
  if (!candidates.length) return names.map(() => null);

  const prepared = candidates.map((c) => ({
    id: c.id,
    kind: c.kind ?? 'user',
    aliases: c.aliases.map(normalise).filter(Boolean),
  }));

  return names.map((raw) => {
    const n = normalise(raw);
    if (!n) return null;
    const nTokens = n.split(' ');

    let best: { id: number; kind: PassengerKind; score: number } | null = null;
    let tiedAtBest = false;
    const consider = (id: number, kind: PassengerKind, score: number) => {
      if (!best || score < best.score) { best = { id, kind, score }; tiedAtBest = false; }
      else if (score === best.score && !(best.id === id && best.kind === kind)) tiedAtBest = true;
    };

    for (const c of prepared) {
      for (const a of c.aliases) {
        if (!a) continue;
        if (a === n) { consider(c.id, c.kind, 0); continue; }
        const aTokens = a.split(' ').filter(Boolean);
        if (aTokens.length > 0 && aTokens.every((t) => nTokens.includes(t))) {
          consider(c.id, c.kind, 1);
          continue;
        }
        const d = levenshtein(a, n);
        if (d <= 2) consider(c.id, c.kind, 2 + d);
      }
    }

    if (!best || tiedAtBest) return null;
    const winner = best as { id: number; kind: PassengerKind; score: number };
    return { kind: winner.kind, id: winner.id };
  });
}

function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Classic two-row DP.
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
