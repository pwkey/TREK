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
  voter_email: string | null;
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
  voterEmail?: string | null,
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
      INSERT INTO availability_poll_votes (poll_id, option_id, voter_name, voter_email, voter_browser_id, choice, comment, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(poll_id, option_id, voter_browser_id) DO UPDATE SET
        voter_name = excluded.voter_name,
        voter_email = excluded.voter_email,
        choice = excluded.choice,
        comment = excluded.comment,
        updated_at = CURRENT_TIMESTAMP
    `);
    const emailNorm = voterEmail?.trim() ? voterEmail.trim().toLowerCase() : null;
    for (const c of choices) {
      upsert.run(pollId, c.option_id, voterName.trim(), emailNorm, voterBrowserId.trim(), c.choice, c.comment ?? null);
    }
    return db.prepare(`SELECT * FROM availability_poll_votes WHERE poll_id = ? AND voter_browser_id = ? ORDER BY option_id`)
      .all(pollId, voterBrowserId.trim()) as PollVote[];
  })();
}

// ---------------------------------------------------------------------------
// Slice 9.4 — Vacay-addon pre-fill suggestions.
// ---------------------------------------------------------------------------

export interface VacayPrefill {
  option_id: number;
  /** Suggested choice based on how much of the date range overlaps
   *  with the user's existing vacation days:
   *    full coverage → 'yes', no coverage → 'no', partial → 'maybe'. */
  suggested: 'yes' | 'no' | 'maybe';
  /** Number of days in the option's range. */
  total_days: number;
  /** Number of those days that already have a vacation entry for the
   *  logged-in user. */
  vacay_days: number;
}

/** Iterate every date between start and end inclusive (YYYY-MM-DD). */
function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const a = new Date(start + 'T00:00:00Z');
  const b = new Date(end + 'T00:00:00Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return out;
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function computeVacayPrefill(pollId: number, userId: number): VacayPrefill[] {
  const options = db.prepare(`SELECT * FROM availability_poll_options WHERE poll_id = ? ORDER BY sort_order`).all(pollId) as PollOption[];
  if (options.length === 0) return [];

  // Find the user's active vacay plan (own or fused).
  const fused = db.prepare(`SELECT plan_id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'`).get(userId) as { plan_id: number } | undefined;
  const ownPlan = db.prepare(`SELECT id FROM vacay_plans WHERE owner_id = ?`).get(userId) as { id: number } | undefined;
  const planId = fused?.plan_id ?? ownPlan?.id;
  if (!planId) {
    // No vacay plan yet — return everything as 'no' / 'no overlap'.
    return options.map(o => ({
      option_id: o.id,
      suggested: 'no' as const,
      total_days: eachDate(o.start_date, o.end_date).length,
      vacay_days: 0,
    }));
  }

  return options.map(o => {
    const dates = eachDate(o.start_date, o.end_date);
    if (dates.length === 0) {
      return { option_id: o.id, suggested: 'no' as const, total_days: 0, vacay_days: 0 };
    }
    const placeholders = dates.map(() => '?').join(',');
    const overlap = (db.prepare(
      `SELECT COUNT(*) AS n FROM vacay_entries WHERE plan_id = ? AND user_id = ? AND date IN (${placeholders})`,
    ).get(planId, userId, ...dates) as { n: number }).n;
    let suggested: VacayPrefill['suggested'];
    if (overlap === dates.length) suggested = 'yes';
    else if (overlap === 0) suggested = 'no';
    else suggested = 'maybe';
    return { option_id: o.id, suggested, total_days: dates.length, vacay_days: overlap };
  });
}

// ---------------------------------------------------------------------------
// Slice 9.3 — convert a poll's winning option into a trip.
// ---------------------------------------------------------------------------

export interface ConvertResult {
  trip_id: number;
  invited_user_ids: number[];
  /** Voters that voted yes/maybe but couldn't be auto-invited (no email
   *  or no matching account). Owner can use these names + emails to
   *  send manual invites via the trip's existing member-add UI. */
  manual_invite_hints: { name: string; email: string | null; choice: 'yes' | 'maybe' }[];
}

/** Build a trip from the chosen option's date range, set the poll's
 *  finalised_trip_id, and auto-invite voters who have a matching user
 *  account on this instance. Caller must have already verified
 *  ownership of the poll. */
export function convertPollToTrip(
  pollId: number,
  optionId: number,
  ownerUserId: number,
  opts: { title?: string } = {},
): ConvertResult {
  const poll = db.prepare(`SELECT * FROM availability_polls WHERE id = ?`).get(pollId) as PollRow | undefined;
  if (!poll) throw new Error('Poll not found');
  if (poll.owner_user_id !== ownerUserId) throw new Error('Not authorised');
  if (poll.finalised_trip_id) throw new Error('Poll already converted to a trip');

  const option = db.prepare(`SELECT * FROM availability_poll_options WHERE id = ? AND poll_id = ?`).get(optionId, pollId) as PollOption | undefined;
  if (!option) throw new Error('Option does not belong to poll');

  return db.transaction((): ConvertResult => {
    const tripTitle = opts.title?.trim() || poll.title;
    const tripResult = db.prepare(`
      INSERT INTO trips (user_id, title, description, start_date, end_date, is_archived)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(ownerUserId, tripTitle, poll.description ?? null, option.start_date, option.end_date);
    const newTripId = Number(tripResult.lastInsertRowid);

    // Auto-invite voters: pick the latest vote per browser_id on THIS
    // option only, filter to yes/maybe, and try to match each one's
    // email against an existing user.
    const optionVotes = db.prepare(`
      SELECT voter_name, voter_email, choice
      FROM availability_poll_votes
      WHERE poll_id = ? AND option_id = ? AND choice IN ('yes','maybe')
    `).all(pollId, optionId) as { voter_name: string; voter_email: string | null; choice: 'yes' | 'maybe' }[];

    const invited = new Set<number>();
    const manualHints: ConvertResult['manual_invite_hints'] = [];
    const inviteStmt = db.prepare(`INSERT OR IGNORE INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)`);

    for (const v of optionVotes) {
      const email = v.voter_email?.trim().toLowerCase();
      if (email) {
        const user = db.prepare(`SELECT id FROM users WHERE LOWER(email) = ?`).get(email) as { id: number } | undefined;
        if (user && user.id !== ownerUserId && !invited.has(user.id)) {
          inviteStmt.run(newTripId, user.id, ownerUserId);
          invited.add(user.id);
          continue;
        }
      }
      manualHints.push({ name: v.voter_name, email: v.voter_email, choice: v.choice });
    }

    db.prepare(`UPDATE availability_polls SET finalised_trip_id = ? WHERE id = ?`).run(newTripId, pollId);

    return {
      trip_id: newTripId,
      invited_user_ids: Array.from(invited),
      manual_invite_hints: manualHints,
    };
  })();
}
