import { describe, it, expect } from 'vitest';
import { matchPassengers } from '../../src/services/reservationImport/passengerMatcher';

const ALICE = { id: 1, aliases: ['alice', 'alice smith', 'alice@example.com'] };
const BOB = { id: 2, aliases: ['bob', 'bob jones', 'bob@example.com'] };
const U = (id: number) => ({ kind: 'user' as const, id });
const M = (id: number) => ({ kind: 'member' as const, id });

describe('matchPassengers', () => {
  it('exact full-name match', () => {
    expect(matchPassengers(['Alice Smith'], [ALICE, BOB])).toEqual([U(1)]);
  });

  it('case-insensitive', () => {
    expect(matchPassengers(['ALICE SMITH', 'bob jones'], [ALICE, BOB])).toEqual([U(1), U(2)]);
  });

  it('strips diacritics and punctuation', () => {
    expect(matchPassengers(['Álïcé  Smíth,'], [ALICE, BOB])).toEqual([U(1)]);
  });

  it('first+last split against the username alias', () => {
    const c = { id: 7, aliases: ['peter.key'] };
    expect(matchPassengers(['Peter Key'], [c])).toEqual([U(7)]);
  });

  it('last-first order still matches via token set', () => {
    expect(matchPassengers(['Smith, Alice'], [ALICE, BOB])).toEqual([U(1)]);
  });

  it('small typos within Levenshtein threshold', () => {
    expect(matchPassengers(['Bobb Jones'], [ALICE, BOB])).toEqual([U(2)]);
  });

  it('unrelated passenger → null', () => {
    expect(matchPassengers(['Carol Danvers'], [ALICE, BOB])).toEqual([null]);
  });

  it('ambiguous tie between candidates → null (avoid false positives)', () => {
    const twins = [
      { id: 10, aliases: ['pat'] },
      { id: 11, aliases: ['pat'] },
    ];
    expect(matchPassengers(['Pat'], twins)).toEqual([null]);
  });

  it('multiple names map independently, including one miss', () => {
    expect(matchPassengers(['Alice', 'Bob', 'Someone Else'], [ALICE, BOB])).toEqual([U(1), U(2), null]);
  });

  it('empty candidate list → all null', () => {
    expect(matchPassengers(['Alice'], [])).toEqual([null]);
  });

  it('empty name → null entry', () => {
    expect(matchPassengers([''], [ALICE])).toEqual([null]);
  });

  // [460-fork] M11 slice 5 — named household_members as candidates.
  describe('with household_member candidates (M11)', () => {
    it('matches a named member by exact name', () => {
      const EMILY = { id: 42, kind: 'member' as const, aliases: ['emily key'] };
      expect(matchPassengers(['Emily Key'], [ALICE, EMILY])).toEqual([M(42)]);
    });

    it('returns the kind so the route can split user vs member matches', () => {
      const EMILY = { id: 42, kind: 'member' as const, aliases: ['emily key'] };
      const result = matchPassengers(['Alice Smith', 'Emily Key', 'Stranger'], [ALICE, EMILY]);
      expect(result).toEqual([U(1), M(42), null]);
    });

    it('tie between a user and a member alias resolves to null (no false positive)', () => {
      const SAME_USER = { id: 5, kind: 'user' as const, aliases: ['pat'] };
      const SAME_MEMBER = { id: 6, kind: 'member' as const, aliases: ['pat'] };
      expect(matchPassengers(['Pat'], [SAME_USER, SAME_MEMBER])).toEqual([null]);
    });
  });
});
