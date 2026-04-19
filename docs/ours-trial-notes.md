# ours-trial-notes.md — 460 Trip Planner

A running journal of how the app actually performs on real trips. Planning-stage opinions are guesses; trip-use observations are data. This document is where data lives.

Referenced from `CLAUDE.md` §5.3 (baseline trial) and §11 (post-trip review prompt).

---

## How this document works

Three sections, each with a specific purpose:

1. **Open pain points** — the live list. New observations land here. Items get sorted into "needs action" vs "nice-to-have" vs "wontfix" over time, but none of that happens during a trip. During a trip, just capture.
2. **Trip logs** — one entry per trip, newest first. Raw observations with timestamps. Think field notes, not polished review.
3. **Resolved items archive** — once a pain point is addressed (shipped a fix, wrote it off, or decided it's not worth solving), it moves here with a one-line outcome.

### Capture rules

- Capture observations in the moment on phone. Clean-up happens post-trip, not mid-trip.
- Don't censor. "Auto-sync felt slow" is a valid note even if you don't yet know whether it was the server, the network, or your perception.
- Distinguish observation from interpretation. "Journal took 4 taps to open from map view" (observation) is more useful than "journal UX is bad" (interpretation).
- If unsure whether something is a bug, a missing feature, or a misuse, write it down anyway and sort later.

### Review cadence

- **Immediately after a trip:** move that trip's observations from phone notes into the Trip Logs section, then propagate anything significant into Open Pain Points.
- **After every second or third trip:** prune the Open Pain Points list. Group similar items, promote anything hit repeatedly, demote anything that only came up once under unusual conditions.
- **Before starting a new milestone:** re-read Open Pain Points. Use it to pressure-test the milestone scope. If a pain point is more painful than the planned feature, question the plan.

### Working with Claude Code on this file

Suggested session prompt after a trip:

> Read docs/ours-trial-notes.md. I just returned from [trip name]. Here are my raw notes: [paste]. Help me turn these into a structured trip log entry, then suggest which items should flow into Open Pain Points and at what priority. Don't start coding anything.

Claude Code should not edit this file autonomously during feature work — it's a human judgment document. Editing rights: me, via pasting notes or via the prompt above.

---

## Open pain points

Sorted roughly by how painful, most painful first. Each item should have:

- A short descriptive title
- One or two sentences of context
- Where it first appeared (trip name or date)
- How many trips it has recurred on
- Current status: `new`, `acknowledged`, `planned`, `deferred`, `wontfix`

*No open pain points yet. This list will populate after Milestone 0 (baseline trial).*

---

## Trip logs

Newest first. Each entry uses the template below. Keep entries short — three or four paragraphs, not an essay.

### Template

```
### [Trip name] — [start date] to [end date]

**App version used:** [e.g. TREK v2.6.2 / 460 Trip Planner milestone N]
**Party:** [solo / couple / two households]
**Primary connectivity:** [e.g. city wifi throughout / mixed / offline for X days]

**What we used the app for:**
- [bullet: planning, journalling, bookings, expenses, map navigation, etc.]

**What worked well:**
- [bullet]

**Friction and gaps:**
- [bullet — one observation per line, tag severity: 🔴 blocking, 🟡 annoying, 🟢 minor]

**Bugs or glitches:**
- [bullet — anything that felt broken rather than missing]

**Feature ideas sparked:**
- [bullet — things we wished existed; feeds into feature-analysis review]

**Verdict:** [one sentence — was the app net-positive on this trip?]
```

### Example entry (placeholder, to be replaced after first real trip)

### Milestone 0 baseline trial — [dates TBD]

**App version used:** TREK v2.6.2 unmodified, installed as PWA on iOS, Android, and desktop.
**Party:** [TBD]
**Primary connectivity:** [TBD]

**What we used the app for:**
- *To be filled in.*

**What worked well:**
- *To be filled in.*

**Friction and gaps:**
- *To be filled in.*

**Bugs or glitches:**
- *To be filled in.*

**Feature ideas sparked:**
- *To be filled in.*

**Verdict:** *To be filled in.*

---

## Resolved items archive

Oldest first (so the running narrative reads chronologically).

When moving an item here from Open Pain Points, include:

- Original description
- Trip(s) where it was observed
- How it was resolved: shipped fix (link to commit/PR), written off as not-worth, addressed by upstream, solved by workflow change, etc.
- Date of resolution

*Nothing resolved yet.*

---

## Notes to myself

- Don't let this document become aspirational. It's a log of what happened, not a list of ambitions. Ambitions live in `feature-analysis.md` and `CLAUDE.md`.
- Don't tidy entries retroactively. The messy original wording often captures useful nuance that clean prose loses.
- If a pain point is genuinely trivial to fix and nobody else would care, fix it and move on without ceremony — not every trivial nit needs a paper trail.
