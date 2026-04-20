import { describe, it, expect } from 'vitest';
import { matchPassengers } from '../../src/services/reservationImport/passengerMatcher';

const ALICE = { id: 1, aliases: ['alice', 'alice smith', 'alice@example.com'] };
const BOB = { id: 2, aliases: ['bob', 'bob jones', 'bob@example.com'] };

describe('matchPassengers', () => {
  it('exact full-name match', () => {
    expect(matchPassengers(['Alice Smith'], [ALICE, BOB])).toEqual([1]);
  });

  it('case-insensitive', () => {
    expect(matchPassengers(['ALICE SMITH', 'bob jones'], [ALICE, BOB])).toEqual([1, 2]);
  });

  it('strips diacritics and punctuation', () => {
    expect(matchPassengers(['Álïcé  Smíth,'], [ALICE, BOB])).toEqual([1]);
  });

  it('first+last split against the username alias', () => {
    const c = { id: 7, aliases: ['peter.key'] };
    expect(matchPassengers(['Peter Key'], [c])).toEqual([7]);
  });

  it('last-first order still matches via token set', () => {
    expect(matchPassengers(['Smith, Alice'], [ALICE, BOB])).toEqual([1]);
  });

  it('small typos within Levenshtein threshold', () => {
    expect(matchPassengers(['Bobb Jones'], [ALICE, BOB])).toEqual([2]);
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
    expect(matchPassengers(['Alice', 'Bob', 'Someone Else'], [ALICE, BOB])).toEqual([1, 2, null]);
  });

  it('empty candidate list → all null', () => {
    expect(matchPassengers(['Alice'], [])).toEqual([null]);
  });

  it('empty name → null entry', () => {
    expect(matchPassengers([''], [ALICE])).toEqual([null]);
  });
});
