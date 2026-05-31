# Milestone 11 — Household (supersedes M3 partner pairing)

**Status:** approved 2026-05-31. Three of six open design questions answered:
- *(Q1) Old partner code:* Drop `partner_user_id` and M3 partner endpoints in this milestone. Migration converts existing pairs to households as it goes.
- *(Q5) Named-member splitting in M8 settle-up:* Defer to a separate later milestone.
- *(Q3) Households per user:* Single household per user — `users.household_id` is a nullable single FK, not a join table.

Remaining open questions (defaults stand unless overridden):
- *(Q2)* Any household user can invite new members (default-yes).
- *(Q4)* M5 last-write-wins handles concurrent named-member edits.
- *(Q6)* No "leave household" effect on existing trips.
**Drives from:** Q10 in `docs/ours-new-user-questions.md`.
**Replaces:** M3 1-to-1 partner pairing as the home-account-grouping primitive.

---

## Goal

Replace the 1-to-1 "partner" model with a "household" model that supports:

- **A. Multiple user accounts** paired together (parent + adult son + adult daughter, each with their own login and PWA install).
- **B. Non-account household members** — names attached to the household for data purposes only (minor children, infants, granny, etc.). No login, no PWA install. They appear in passenger lists, photo captions, and expense math.

A household has *N* user accounts and *M* named members, where N ≥ 1 and M ≥ 0.

## Why now

M3 partner-pairing was deliberately scoped to 1-to-1 with the explicit "Don't do yet" note in CLAUDE.md §6 for "Multi-partner or family-unit (3+ accounts) support". Trip use is now pushing against that limit: a real household has a spouse plus often kids, sometimes adult travel-companions, and the current model can't represent any of that.

## Mental model

Two distinct concepts, *both* needed:

- A **household** is a stable group of people who travel together by default and split expenses together.
- A **household user** is a member with their own account — they edit trips, get notifications, make decisions.
- A **household member** (name-only) is a person who appears on trips but doesn't use the app — bookings list them, expenses count them, but they don't have logins.

A user is in 0 or 1 households at a time. Membership is mutual (both sides accept). Leaving a household preserves your prior trips but removes auto-add behaviour going forward.

---

## Schema

### New tables

**`households`**
```
id          INTEGER PRIMARY KEY
name        TEXT NULL          -- optional, e.g. "The Keys"
created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
created_by  INTEGER NOT NULL REFERENCES users(id)
```

**`household_members`**
```
id            INTEGER PRIMARY KEY
household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE
name          TEXT NOT NULL
dob           DATE NULL           -- optional, useful for fares (infant/child rates)
relationship  TEXT NULL           -- free-form ("daughter", "father-in-law", "dog"). UI hint only.
created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
created_by    INTEGER NOT NULL REFERENCES users(id)
```

**`household_invites`**
```
id              INTEGER PRIMARY KEY
household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE
invitee_email   TEXT NOT NULL
invited_by      INTEGER NOT NULL REFERENCES users(id)
token           TEXT NOT NULL UNIQUE
expires_at      TIMESTAMP NOT NULL
status          TEXT NOT NULL DEFAULT 'pending'   -- pending | accepted | declined | expired
created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

### Changes to existing tables

**`users`** — add `household_id INTEGER NULL REFERENCES households(id) ON DELETE SET NULL`.

**`users.partner_user_id`** — **dropped in this milestone** (per Q1 answer). The migration converts existing pairs to 2-person households *then* drops the column in the same migration step. All M3-era code that referenced it is updated to read `household_id` instead in slice 1; the migration is gated to run only after slice 1's code has shipped, so there's no window where the old column is read while not present.

### Migration

One-time script in the migrations chain:

1. For each user X with `partner_user_id = Y` AND `X.id < Y.id` (so we only process each pair once):
   - Create a household with `name = NULL`, `created_by = X.id`.
   - Set `X.household_id = Y.household_id = household.id`.
2. Leave `partner_user_id` populated (defensive; drop in a later commit).
3. Mark migration version in the schema.

Existing partners see no UX change — they're now in a 2-person household, can add named members or invite a third user.

---

## Backend changes

### New service: `householdService.ts`
- `createHousehold(userId, name?)` → creates household, sets user.household_id.
- `inviteUser(householdId, email, invitedBy)` → creates invite row, returns token. (Email send is no-op until SMTP is configured; the invite is still claimable via in-app notification.)
- `acceptInvite(token, userId)` → moves user to invitee household; if user was previously in a household alone, dissolves the old one.
- `leaveHousehold(userId)` → sets user.household_id = NULL. If last user, the household + named members are deleted.
- `addMember(householdId, { name, dob?, relationship? }, byUserId)` → creates household_member row.
- `updateMember`, `deleteMember`.
- `getHouseholdForUser(userId)` → returns `{ household, users[], members[] }` or null.

### Updated services
- **`tripService.createTrip`**: was "if creator has partner_user_id, add partner as member". New: "if creator has household_id, add every other user in the household as a member."
- **`reservationImport` passenger matcher**: was matching against `[user, partner]`. New: `[user, ...household_users, ...household_members]`.

### REST routes
- `POST /api/household` — create
- `GET /api/household` — get current user's household + roster
- `POST /api/household/invite` — invite by email
- `POST /api/household/accept/:token` — accept an invite
- `POST /api/household/leave` — leave
- `POST /api/household/members` — add named member
- `PUT /api/household/members/:id` — edit
- `DELETE /api/household/members/:id` — remove

The existing M3 partner endpoints (`POST /api/partner/pair`, etc.) stay but redirect to the household ones (returning a deprecation hint in the response). Removed in a follow-up commit.

### Permissions
- Any household user can invite, add named members, edit named members.
- Only the user themselves can leave.
- Named members aren't editable by their dob (no consent flow needed — they're not accounts).

---

## Frontend changes

### Settings → Account → Household (replaces "Partner pairing")

A single panel showing:

- **Household name** (editable, optional)
- **Members with accounts** (you + any user-account peers):
  - Avatar, name, email, "Invite pending" badge if applicable
  - "Remove" for peers if you created the household; "Leave" button for self
- **Named members** (no-account):
  - Name, optional dob, optional relationship
  - "+ Add" button → small inline form
  - Click to edit / remove
- **"+ Invite by email"** button (opens an inline form; uses the same invite-link pattern as trip invites)

If the user has no household, the panel shows:
- "+ Create household" button → modal asking for optional name → creates household.
- An empty state explaining what households do.

### Smart Import passenger-matching highlight
When a PDF lists "Peter, Clare, Emily" and Emily is a household_member, the import draft shows Emily matched (icon + chip) just like a user-account peer match today. UI mostly already exists from M3 slice 5; just feeds extra candidates.

---

## Slicing (commits / ship order)

Per Q1 answer ("remove old partner code in this milestone"), the previously-planned final cleanup slice is folded into the main work. Each backend slice swaps old partner reads for household reads as it goes, so there's no intermediate state where both code paths exist.

1. **Schema + migration + service + M3 code-path replacement** — new tables (`households`, `household_members`, `household_invites`), migration that converts existing partner pairs to 2-person households *and* drops `users.partner_user_id` in the same migration step, household service with all CRUD + invite/accept/leave operations. M3 `partnerService.ts` becomes a thin shim over `householdService` or is deleted outright (deciding during implementation based on what's cleanest). Server tests cover the migration end-to-end and the service unit-level.

2. **REST routes** — household endpoints exposed. The old M3 partner endpoints (`POST /api/partner/pair`, etc.) are **removed**, not redirected. Integration tests cover happy-path, permissions, invite/accept, leave-and-rejoin.

3. **Settings UI — Household panel** — replaces M3 partner-pairing UI. Multi-user list, named-member CRUD, invite-by-email form. M3 partner UI files deleted.

4. **Trip auto-add wire-through** — `createTrip` adds all household users as members. Tested with 1, 2, and 3+ user households.

5. **Smart Import passenger-matcher update** — passes household roster (users + named members) to the matcher. UI shows household_members as match candidates with the same chip treatment as user-account matches today.

Each slice is independently shippable but slices 1–2 ship together (schema + endpoints land before UI to avoid an unusable interim state).

---

## Open design questions (for product decision before coding)

1. **Single household per user — confirm?** A user can be in 0 or 1 household. Not multiple (no "live with spouse, also have a polycule" or "in two extended families" edge case). Simpler model; revisit if it ever matters.

2. **Can a non-creator household user invite new members?** Default: yes — once you're in, you can invite (matches real households where any adult can invite a friend over). Alternative: only the household creator can invite. Probably default-yes.

3. **What happens to existing trips on leave?** Default: prior trips you're a member of stay; you remain a member. New trips no longer auto-add you. Alternative: prune yourself from in-progress trips on leave. Default seems right.

4. **Named-member edit conflicts.** Two household users could both try to edit "Emily, age 8" simultaneously. M5 offline-first conflict resolution kicks in — last-write-wins on field-level, no special handling. Worth confirming this is OK.

5. **Expense splitting in M8 settle-up.** Today's M8 splits expenses among trip members (user-accounts only). Should named household members count as splittees, free-riders on the booking-er's share, or configurable per-trip? **Open — defer to a follow-up. M11 ships with M8 behaviour unchanged; expense-split-with-named-members is its own milestone.**

6. **Dropping `partner_user_id`.** Migration leaves it populated as a safety net. When is it safe to drop? Probably: after one real trip cycle where you and Clare use households end-to-end without issue. Approximately the same trigger as "we trust the new code now."

---

## Out of scope (deliberately, this milestone)

- Multiple households per user.
- Household-scoped settings (timezone, currency) — each user keeps their own.
- Named-member-aware expense splitting (deferred — its own milestone after M11).
- Importing household composition from an existing family directory.
- Inheritance of household membership to children's accounts when they age up.
- Cross-household links ("the Smiths and the Keys are friends who travel together").

---

## Acceptance criteria for M11 done

- A user can create a household and invite their partner; existing partner pairs continue to work without re-pairing (migrated automatically).
- A household with 3+ user accounts gets every account auto-added to any new trip.
- A user can add a non-account "Emily, age 8" household member, and:
  - Smart Import passenger-matches "Emily" against her.
  - She appears in the household panel in Settings.
- An existing trip pre-dating households continues to function (no members added retroactively unless user explicitly invites them).
- A user who leaves a household sees the household panel reset to empty state; prior trips are untouched.

---

## Notes

Multi-day piece of work. Updated estimate after the Q1 decision to drop old code in-milestone: ~5 commits across server + client, ~600–800 lines of new code, two integration test suites, one schema migration. Slice 1 alone (schema + migration + service + M3 replacement) is the densest — probably most of a day on its own.

Start coding once this plan is approved. The remaining open design questions (Q2, Q4, Q6) have defaults and don't block progress; if real-trip use of M11 surfaces a problem with any default, we revisit.
