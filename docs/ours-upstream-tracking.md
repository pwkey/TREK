# Upstream tracking status

Where our fork sits relative to upstream TREK (`mauriceboe/TREK`), and the
decisions that flow from that. Referenced by CLAUDE.md §4 (fork strategy)
and §12 ("upstream is alive").

---

## Current divergence (as of 2026-05-31)

| | |
|---|---|
| **Our fork point** | TREK **2.9.14** (the version stamped in `client/package.json` + `server/package.json`) |
| **Upstream latest** | TREK **3.0.22** (observed via the in-app version notification before we disabled it 2026-05-31) |
| **Gap** | A **major version** (2.9 → 3.0) plus eleven milestones of our own work (M1–M11) layered on top |
| **Our branch model** | `main` mirrors upstream; `personal` carries all our work. We have NOT rebased `personal` onto a fresh upstream since the original fork. |

## How we discovered the gap

The user got an in-app notification: *"460 Trip Planner 3.0.22 is now
available."* That was TREK's upstream version checker
(`adminService.checkAndNotifyVersion`) comparing our `package.json`
version against the latest GitHub release of `mauriceboe/TREK`. We
disabled that notification on 2026-05-31 (commit `37d50a9`) because for a
fork it misleadingly reads as "your app has an update waiting" — it's
really a "consider rebasing" signal, which belongs here, not in a user
notification.

## The decision this implies (NOT yet actioned)

Upstream has shipped a **major version** since we forked. Per CLAUDE.md §4
we track upstream closely and rebase `personal` onto fresh `main` when
upstream releases. We are now well behind. At some point we need to:

1. `git fetch upstream`
2. Review what changed across 2.9 → 3.0 (`git log --oneline main..upstream/main`)
   — especially: schema/migration changes, auth/session changes, anything
   touching the files our M1–M11 work also touches (segments, days,
   trips, households, reservation-import, day-photos, the notification
   system, the PWA/service-worker config).
3. Assess rebase pain. After 11 milestones of divergence this is the
   "merge-tax" CLAUDE.md §12 warned about. A major bump likely has
   breaking changes.
4. Decide: rebase now, rebase selectively (cherry-pick specific upstream
   improvements), or hold and keep diverging.

**This is deliberately deferred.** It's a substantial, careful piece of
work — not something to start reactively because a notification fired.
Schedule it as its own focused session per the CLAUDE.md §11 "before a
rebase on upstream" starter prompt.

## Risks of letting the gap grow

- The longer we wait, the harder the eventual rebase (more upstream
  commits to reconcile against more of our commits).
- Security fixes in upstream 3.0.x are NOT in our 2.9.14 base. Worth a
  targeted scan of upstream's 3.0 changelog for security-relevant fixes we
  may want to cherry-pick ahead of a full rebase.
- Our `main` branch is stale — it no longer mirrors upstream. Step 1 of any
  rebase is fixing that.

## When we do tackle it

Use the CLAUDE.md §11 starter prompt: *"Upstream has new commits since we
last synced. Fetch, summarise the interesting changes, and flag any that
might conflict with our work on `personal`. Don't merge or rebase yet."*
Then plan the rebase as its own milestone before touching code.

---

## Log

- **2026-05-31** — Noted upstream at 3.0.22 vs our 2.9.14 base. Disabled the
  upstream version-check notification (commit `37d50a9`). Rebase deferred.
