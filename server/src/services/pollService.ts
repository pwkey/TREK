// [460-fork] Milestone 9 — pre-trip availability polls.
//
// Schema:
//   availability_polls           id, owner_user_id, title, description,
//                                share_token, created_at, expires_at,
//                                finalised_trip_id
//   availability_poll_options    id, poll_id, start_date, end_date, sort_order
//   availability_poll_votes      id, poll_id, option_id, voter_name,
//                                voter_browser_id, choice, comment, updated_at
//
// Anonymous voting is identified by `voter_browser_id` (a UUID kept in
// localStorage on the voter's browser) — same UUID on subsequent visits
// lets the same person revise their votes without creating an account.
// We accept that someone clearing localStorage will look like a new
// voter; this is a small-trust system among households, not Doodle for
// the world.
import { randomUUID } from 'node:crypto';
import { db } from '../db/database';

export interface PollRow {
  id: number;
  owner_user_id: number;
  title: string;
  description: string | null;
  share_token: string;
  created_at: string;
  expires_at: string | null;
  finalised_trip_id: number | null;
}

export interface PollOption {
  id: number;
  poll_id: number;
  start_date: string;
  end_date: string;
  sort_order: number;
}

export interface PollVote {
  id: number;
  poll_id: number;
  option_id: number;
  voter_name: string;
  voter_browser_id: string;
  choice: 'yes' | 'no' | 'maybe';
  comment: string | null;
  updated_at: string;
}

export interface PollWithOptions extends PollRow {
  options: PollOption[];
}

export interface PollWithVotes extends PollWithOptions {
  votes: PollVote[];
}

export function createPoll(
  ownerUserId: number,
  data: { title: string; description?: string | null; options: { start_date: string; end_date: string }[]; expires_at?: string | null },
): PollWithOptions {
  if (!data.title?.trim()) throw new Error('Poll title required');
  if (!Array.isArray(data.options) || data.options.length === 0) throw new Error('At least one option required');

  const token = randomUUID();
  return db.transaction((): PollWithOptions => {
    const r = db.prepare(`
      INSERT INTO availability_polls (owner_user_id, title, description, share_token, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ownerUserId, data.title.trim(), data.description ?? null, token, data.expires_at ?? null);
    const pollId = Number(r.lastInsertRowid);
    const insertOpt = db.prepare(`INSERT INTO availability_poll_options (poll_id, start_date, end_date, sort_order) VALUES (?, ?, ?, ?)`);
    data.options.forEach((opt, idx) => {
      if (!opt.start_date || !opt.end_date) throw new Error('Option requires start_date and end_date');
      insertOpt.run(pollId, opt.start_date, opt.end_date, idx);
    });
    return getPollById(pollId)!;
  })();
}

export function listMyPolls(ownerUserId: number): PollWithOptions[] {
  const polls = db.prepare(`
    SELECT * FROM availability_polls WHERE owner_user_id = ? ORDER BY created_at DESC
  `).all(ownerUserId) as PollRow[];
  if (polls.length === 0) return [];
  const ids = polls.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const opts = db.prepare(`
    SELECT * FROM availability_poll_options WHERE poll_id IN (${placeholders}) ORDER BY poll_id, sort_order
  `).all(...ids) as PollOption[];
  const byPoll: Record<number, PollOption[]> = {};
  for (const o of opts) (byPoll[o.poll_id] ??= []).push(o);
  return polls.map(p => ({ ...p, options: byPoll[p.id] || [] }));
}

export function getPollById(id: number): PollWithOptions | null {
  const poll = db.prepare(`SELECT * FROM availability_polls WHERE id = ?`).get(id) as PollRow | undefined;
  if (!poll) return null;
  const options = db.prepare(`SELECT * FROM availability_poll_options WHERE poll_id = ? ORDER BY sort_order`).all(id) as PollOption[];
  return { ...poll, options };
}

export function getPollByToken(token: string): PollWithOptions | null {
  const poll = db.prepare(`SELECT * FROM availability_polls WHERE share_token = ?`).get(token) as PollRow | undefined;
  if (!poll) return null;
  const options = db.prepare(`SELECT * FROM availability_poll_options WHERE poll_id = ? ORDER BY sort_order`).all(poll.id) as PollOption[];
  return { ...poll, options };
}

export function getPollWithVotes(idOrToken: { id?: number; token?: string }): PollWithVotes | null {
  const base = idOrToken.id != null ? getPollById(idOrToken.id) : (idOrToken.token ? getPollByToken(idOrToken.token) : null);
  if (!base) return null;
  const votes = db.prepare(`SELECT * FROM availability_poll_votes WHERE poll_id = ? ORDER BY voter_browser_id, option_id`).all(base.id) as PollVote[];
  return { ...base, votes };
}

/** Owner-side delete. Cascade handles options + votes. */
export function deletePoll(id: number, ownerUserId: number): boolean {
  const r = db.prepare(`DELETE FROM availability_polls WHERE id = ? AND owner_user_id = ?`).run(id, ownerUserId);
  return r.changes > 0;
}

/** Public vote submission. Idempotent per (poll, option, browser_id) —
 *  the same browser submitting again updates its vote rather than
 *  creating duplicates. Other voters with their own browser_id slot in
 *  alongside without conflict. */
export function submitVotes(
  pollId: number,
  voterName: string,
  voterBrowserId: string,
  choices: { option_id: number; choice: 'yes' | 'no' | 'maybe'; comment?: string | null }[],
): PollVote[] {
  if (!voterName?.trim()) throw new Error('Voter name required');
  if (!voterBrowserId?.trim()) throw new Error('Voter browser id required');

  // Confirm all options belong to this poll.
  const validOptionIds = new Set(
    (db.prepare(`SELECT id FROM availability_poll_options WHERE poll_id = ?`).all(pollId) as { id: number }[]).map(o => o.id),
  );
  for (const c of choices) {
    if (!validOptionIds.has(c.option_id)) throw new Error(`Option ${c.option_id} does not belong to poll ${pollId}`);
    if (!['yes', 'no', 'maybe'].includes(c.choice)) throw new Error(`Invalid choice "${c.choice}"`);
  }

  return db.transaction((): PollVote[] => {
    const upsert = db.prepare(`
      INSERT INTO availability_poll_votes (poll_id, option_id, voter_name, voter_browser_id, choice, comment, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(poll_id, option_id, voter_browser_id) DO UPDATE SET
        voter_name = excluded.voter_name,
        choice = excluded.choice,
        comment = excluded.comment,
        updated_at = CURRENT_TIMESTAMP
    `);
    for (const c of choices) {
      upsert.run(pollId, c.option_id, voterName.trim(), voterBrowserId.trim(), c.choice, c.comment ?? null);
    }
    return db.prepare(`SELECT * FROM availability_poll_votes WHERE poll_id = ? AND voter_browser_id = ? ORDER BY option_id`)
      .all(pollId, voterBrowserId.trim()) as PollVote[];
  })();
}
