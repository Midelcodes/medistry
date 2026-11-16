/**
 * Name normalisation and comparison for duplicate detection (Phase 16).
 *
 * Patterns this has to cope with across West and East Africa, without assuming one naming order:
 *   - several given names ("Chukwuemeka Obinna"), with any of them used day to day;
 *   - family name first or last ("Okonkwo Amara" / "Amara Okonkwo"), and reordered middle names;
 *   - hyphenated or joined compounds ("Adebayo-Johnson", "Wanjiku Kamau-Njoroge", "Olu Wole" vs "Oluwole");
 *   - diacritics and tone marks (Yoruba "Ọlágúnjú" = "Olagunju", Hausa hooked letters such as "ɗ", "ƙ", "ɓ");
 *   - titles and honorifics written into the name field ("Dr", "Alhaji", "Chief");
 *   - connective particles that carry no identity on their own ("bin", "binti", "wa", "ibn", "d/o", "s/o").
 * Names are compared as an unordered set of tokens with a per-token string similarity, so order swaps and extra
 * middle names lower the score a little instead of breaking the match. This is a scoring aid for a human
 * reviewer, never a basis for an automatic merge.
 */

// Written into name fields but not part of the name. Lower case, without dots. Kept to unambiguous honorifics:
// words that are also common names or surnames (e.g. Eze, Oba, Sheikh, Mama, Baba) are deliberately not here.
const TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'revd', 'pastor', 'chief', 'hon', 'engr', 'barr',
  'alhaji', 'alhaja', 'alh', 'hajia', 'hajiya', 'mallam', 'malam',
]);
// Connectives between a given name and a parent's or clan name.
const PARTICLES = new Set(['bin', 'binti', 'bint', 'ibn', 'wa', 'd/o', 's/o']);

// Letters that do not decompose under NFD.
const FOLD: Record<string, string> = { 'ɗ': 'd', 'ƙ': 'k', 'ɓ': 'b', 'ƴ': 'y', 'ŋ': 'n', 'ɛ': 'e', 'ɔ': 'o', 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'ð': 'd', 'þ': 'th', 'ł': 'l' };

/** Lower case, diacritics and tone marks removed, special letters folded, only a-z left. */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[ɗƙɓƴŋɛɔßæøðþł]/g, (c) => FOLD[c] || c);
}

/**
 * The tokens of a full name: folded, split on spaces, hyphens, apostrophes and punctuation, without titles,
 * particles and single letters (initials). Order is not meaningful.
 */
export function nameTokens(...parts: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const raw of foldName(parts.filter(Boolean).join(' ')).split(/[\s\-'’`.,;:()]+/)) {
    const t = raw.replace(/[^a-z/]/g, '');
    if (!t || PARTICLES.has(t)) continue;
    const word = t.replace(/\//g, '');
    if (word.length < 2 || TITLES.has(word)) continue;
    out.push(word);
  }
  return out;
}

/** Jaro-Winkler similarity (0..1) for short strings such as name tokens. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array(a.length).fill(false);
  const bHit = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Similarity of two full names (0..1), independent of token order.
 * Each token of the shorter name is paired with its best unused match in the longer one; compounds written apart
 * ("olu wole") are also tried joined ("oluwole"). Extra tokens on one side (an extra middle name) cost a little.
 */
export function nameSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const withJoins = (xs: string[]) => [...xs, ...xs.slice(1).map((x, i) => xs[i] + x)];
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const candidates = withJoins(long);
  const used = new Set<number>();
  let total = 0;
  for (const s of short) {
    let best = 0;
    let bestAt = -1;
    candidates.forEach((c, i) => {
      if (used.has(i)) return;
      const score = jaroWinkler(s, c);
      if (score > best) { best = score; bestAt = i; }
    });
    if (bestAt >= 0) used.add(bestAt);
    total += best < 0.8 ? 0 : best; // weak similarities are noise, not evidence
  }
  const coverage = short.length / long.length;
  const joinedShort = withJoins(short).slice(short.length);
  const joinedBonus = joinedShort.some((j) => long.includes(j)) ? 0.1 : 0;
  return Math.min(1, (total / short.length) * (0.8 + 0.2 * coverage) + joinedBonus);
}
