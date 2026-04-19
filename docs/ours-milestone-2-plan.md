# Milestone 2 Implementation Plan — Smart Import from Reservation Documents and Emails

**Status:** draft, pending approval
**Date:** 2026-04-19
**Feature spec:** `CLAUDE.md` §6 Milestone 2
**Architecture context:** `docs/ours-architecture-map.md`

Update this doc as the implementation proceeds (mark slices as done, strike out discarded options, move answered open questions to a decision log). On completion, move to a resolved-plans archive or delete.

---

## Orientation notes (material findings that shaped the plan)

A few codebase truths that materially shape this plan:

- **Existing reservations table uses `INTEGER PRIMARY KEY AUTOINCREMENT`, not UUIDs.** `server/src/db/schema.ts:164-180`. CLAUDE.md §9 mandates UUIDs for *new* tables. The plan uses UUID (TEXT) for the new `reservation_imports` table with `created_at`/`updated_at`/`created_by`/`updated_by` per §9, without touching existing integer IDs. Listed as a must-decide question below — §9 is in tension with the rest of the schema.
- **There is no mutation-queue data layer yet.** `client_mutation_id` is referenced in CLAUDE.md §7.4 and the architecture map but **nowhere in code** (grep confirms). Milestone 2 arrives *before* Milestone 4 (offline-first). For this milestone, the plan accepts the `client_mutation_id` header on the new endpoints as a no-op passthrough (store it, dedupe if present, otherwise ignore) so we don't retrofit later. The extract endpoint itself is a read-only compute call, so offline-first is moot there — you can't LLM-extract without network.
- **Client components already bypass the "no direct `fetch`" rule in several places** (e.g. `apiClient.post` is called directly from `ReservationModal.tsx:3`). The convention as actually practised is: route every call through `client/src/api/client.ts`, and go through a Zustand slice for state-owned data. The plan follows that.
- **`zod` is already a server dependency** (`server/package.json:38`) but used only in `server/src/mcp/tools.ts`. The plan introduces a tiny zod-based request validator for the new endpoints rather than shoehorning into the current `middleware/validate.ts`.
- **Settings pattern for non-user-scoped config is the `app_settings` key-value table**, with `apiKeyCrypto.maybe_encrypt_api_key` for secrets. Example: `server/src/services/adminService.ts:238-266` (OIDC settings). The plan mirrors this exactly.
- **No Docker, no existing Ollama.** User is on Windows 11 without Docker. Ollama runs natively on Windows; the dev server calls it over HTTP on localhost.

---

## 1. Commit slicing (6 commits)

| # | Commit title | What works after it lands | What still doesn't |
|---|---|---|---|
| 1 | `feat(reservations): add reservation_imports audit table + admin settings for extraction provider` | DB table exists; admin panel has a new "Smart Import" section where Ollama URL, model name, and fallback (Anthropic/OpenAI) API keys can be set and persist encrypted. No user-facing extract action yet. | No extraction endpoint; no UI on reservation form. |
| 2 | `feat(reservations): extraction service with pdf-parse + Ollama structured-output adapter` | Server-side service can take a PDF buffer or email text and return a parsed draft reservation JSON object. Covered by unit tests using recorded fixtures and a mocked Ollama response. | No HTTP endpoint yet; not wired to the client. |
| 3 | `feat(reservations): POST /extract endpoint, persists raw + parsed to reservation_imports` | End-to-end: authenticated, trip-scoped endpoint accepts `multipart/form-data` (PDF) or JSON (email text), returns draft. An audit row is written on every call. | No client UI hook — the endpoint exists but the reservation modal doesn't call it yet. |
| 4 | `feat(reservations): "Import from document/email" entry in ReservationModal; pre-fill + auto-attach PDF` | User flow works end-to-end on web: click button, pick PDF or paste email, review prefilled form, save. The uploaded PDF is auto-attached via the existing `trip_files` + `file_links` path. | No OCR fallback for image-only PDFs; no Anthropic/OpenAI fallback adapter wired. |
| 5 | `feat(reservations): OpenAI + Anthropic fallback adapters behind admin-panel toggle` | Admin can pick provider; same endpoint uses the configured provider. API key opt-in is explicit (provider = `ollama` by default). | OCR still gated; flight-legs not modelled yet (see slice 6). |
| 6 | `feat(reservations): tesseract.js OCR fallback + flight-leg normalisation` | Image-only PDFs still yield a draft (slower). Multi-leg flights come back as one reservation with N legs in `metadata.legs[]`. | Inbound email receiving — explicitly out of scope per CLAUDE.md §6 "Don't do yet". |

Each commit should pass lint, typecheck, and the existing test suite. Slices 1-4 are the MVP; 5 and 6 are independently deferrable.

---

## 2. Per-slice details

### Slice 1 — `reservation_imports` table + admin settings

**Files added:**
- `server/src/services/importSettingsService.ts` — get/set the extraction provider config. Mirrors `adminService.getOidcSettings` / `updateOidcSettings`.

**Files modified:**
- `server/src/db/schema.ts` — append `CREATE TABLE reservation_imports` (fresh-install path). Not actively churning upstream recently. Low merge risk.
- `server/src/db/migrations.ts` ⚠️ — append a new migration thunk. **Upstream actively appends migrations every release.** Will rebase-conflict on every upstream sync. Remediation: always move our thunk to the tail of the array. Document in the migration comment.
- `server/src/services/adminService.ts` ⚠️ — *upstream actively edits this file.* **Prefer additive:** put new functions in `importSettingsService.ts` only; don't touch `adminService.ts`.
- `server/src/routes/admin.ts` ⚠️ — add `GET /api/admin/import-settings`, `PUT /api/admin/import-settings`. *Upstream actively edits this file.* Unavoidable. Keep additions as a small contiguous block at the bottom with a clear comment marker.
- `client/src/api/client.ts` ⚠️ — add `adminApi.getImportSettings` / `updateImportSettings`. *Upstream actively edits this file.* Unavoidable.
- `client/src/pages/AdminPage.tsx` — add a new section/panel for Smart Import. Potentially upstream-active. Prefer extracting a separate panel component.

**Files added (client):**
- `client/src/components/Admin/SmartImportPanel.tsx` — provider dropdown (`ollama` / `anthropic` / `openai` / `disabled`), Ollama base URL, Ollama model, Anthropic API key (masked), OpenAI API key (masked), enable-OCR-fallback toggle.

**Migration** (appended to `server/src/db/migrations.ts`, per existing convention `Migration N: <what>`):

```ts
// Migration 113: reservation_imports — audit trail for LLM-driven reservation extraction
() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservation_imports (
      id TEXT PRIMARY KEY,                 -- UUID (per CLAUDE.md §9 for new tables)
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
      source_type TEXT NOT NULL,           -- 'pdf' | 'email_text' | 'ocr'
      source_file_id INTEGER REFERENCES trip_files(id) ON DELETE SET NULL,
      raw_text TEXT,                       -- extracted plain text (cap 200KB; truncate beyond)
      parsed_json TEXT,                    -- JSON.stringify(draft)
      confidence REAL,                     -- 0..1 from the model's self-report OR null
      status TEXT NOT NULL DEFAULT 'draft',-- 'draft' | 'applied' | 'discarded' | 'failed'
      provider TEXT,                       -- 'ollama' | 'anthropic' | 'openai'
      model TEXT,                          -- e.g. 'llama3.1:8b', 'claude-opus-4-7'
      error_message TEXT,
      client_mutation_id TEXT,             -- accepted now; queue doesn't exist yet
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reservation_imports_trip ON reservation_imports(trip_id);
    CREATE INDEX IF NOT EXISTS idx_reservation_imports_created_by ON reservation_imports(created_by);
    CREATE INDEX IF NOT EXISTS idx_reservation_imports_cmid ON reservation_imports(client_mutation_id);
  `);
}
```

**Admin settings keys** (in `app_settings`, mirroring OIDC pattern):
- `import_provider` — `'disabled' | 'ollama' | 'anthropic' | 'openai'`. Default `'disabled'`.
- `import_ollama_url` — default `'http://localhost:11434'`.
- `import_ollama_model` — default `'llama3.1:8b'`.
- `import_anthropic_key` — encrypted via `maybe_encrypt_api_key`.
- `import_openai_key` — encrypted via `maybe_encrypt_api_key`.
- `import_anthropic_model` — default `'claude-sonnet-4-5'`. Optional.
- `import_openai_model` — default `'gpt-4o-mini'`. Optional.
- `import_ocr_enabled` — `'true' | 'false'`. Default `'false'`.

Add `'import_anthropic_key'` and `'import_openai_key'` to `ENCRYPTED_SETTING_KEYS` in `settingsService.ts` — same pattern as `oidc_client_secret`: encrypt at write, `decrypt_api_key` at read, never return plaintext in GET (return a boolean `..._set` flag).

**API endpoints:**

```ts
GET  /api/admin/import-settings
// Response:
{
  provider: 'disabled' | 'ollama' | 'anthropic' | 'openai';
  ollama_url: string;
  ollama_model: string;
  anthropic_model: string;
  openai_model: string;
  anthropic_key_set: boolean;
  openai_key_set: boolean;
  ocr_enabled: boolean;
}

PUT  /api/admin/import-settings
// Request (all optional; only provided fields update):
{
  provider?: 'disabled' | 'ollama' | 'anthropic' | 'openai';
  ollama_url?: string;
  ollama_model?: string;
  anthropic_model?: string;
  openai_model?: string;
  anthropic_key?: string | null;   // null clears
  openai_key?: string | null;
  ocr_enabled?: boolean;
}
// Response: same as GET. Audit event 'admin.import_settings_update'.
```

**Tests:**
- `server/tests/integration/importSettings.test.ts` — non-admin is 403; admin round-trip of all fields; API key not returned in GET; clearing key with `null` flips `_set` to `false`; encryption prefix is present at the DB layer.

**Dependencies:** none in this slice.

**Upstream contribution stance:** **Do NOT upstream.** Bakes our LLM architecture into core settings. Defer until after slice 4.

---

### Slice 2 — Extraction service (pdf-parse + Ollama)

**Files added:**
- `server/src/services/reservationImport/extractor.ts` — orchestrator: `extractReservationDraft({ source: { kind: 'pdf', buffer } | { kind: 'email_text', text }, context: { tripId, userId } }): Promise<ExtractResult>`.
- `server/src/services/reservationImport/pdfTextExtractor.ts` — wrapper around `pdf-parse`. Returns `{ text, pageCount, hadText }`.
- `server/src/services/reservationImport/providers/ollamaProvider.ts` — HTTP client for `POST http://{ollama_url}/api/generate` with `format` set to the JSON schema (Ollama structured output). Timeout 60 s.
- `server/src/services/reservationImport/providers/types.ts` — `LlmProvider` interface: `{ extract(prompt, schema, rawText): Promise<{ parsed, confidence, provider, model }> }`.
- `server/src/services/reservationImport/schema.ts` — canonical JSON schema for a draft reservation (zod schema, converted via `z.toJSONSchema(...)` for Ollama `format`). Fields: `type` (flight/hotel/car/train/other), `title`, `reservation_time` (ISO), `reservation_end_time`, `location`, `confirmation_number`, `provider`, `passenger_names[]`, `legs[]` (flights), `notes`, `currency`, `price`.
- `server/src/services/reservationImport/prompts.ts` — `buildExtractionPrompt(rawText)`. Deterministic.
- `server/tests/unit/reservationImport/extractor.test.ts`, `pdfTextExtractor.test.ts`, `ollamaProvider.test.ts` with mocked `fetch`.
- `server/tests/fixtures/reservation-imports/*.pdf` — 2-3 anonymised real PDFs with `*.expected.json` companions.

**Files modified:** none. Fully additive.

**Dependencies** (`server/`):
- `pdf-parse` (+ `@types/pdf-parse` dev).
- **Do NOT add** `ollama` npm SDK. Use plain `fetch` (Node 22 global).

**Upstream contribution stance:** Likely upstreamable once proven. Provider interface + JSON schema are generic.

---

### Slice 3 — `POST /extract` endpoint

**Files added:**
- `server/src/routes/reservationImport.ts` — sibling of `reservations.ts`. `POST /extract`. Uses `multer` (already a dep) for `multipart/form-data`, streams to `uploads/reservation-imports/` tmp; we do NOT persist by default. If `auto_attach=true` (default on PDF input), the file is moved to the files dir and a `trip_files` row is written — see slice 4.
- `server/src/services/reservationImport/importAuditService.ts` — `recordImportStart`, `recordImportComplete`, `recordImportFailure`, `listImports(tripId)`.
- `server/src/services/reservationImport/validation.ts` — zod schema for request body + a tiny express validator wrapper.

**Files modified:**
- `server/src/app.ts` ⚠️ — register the new route: one line. Upstream-active file but tiny diff.

**Endpoint:**

```ts
POST /api/trips/:tripId/reservation-imports/extract
// multipart/form-data:
//   file?: <PDF>            (max 10 MB)
//   email_text?: string     (max 200 KB)
//   auto_attach?: 'true' | 'false'     (default 'true' if file is present)
// Header (optional): X-Client-Mutation-Id: <uuid>
//
// 200:
{
  import_id: string;            // UUID of reservation_imports row
  draft: {
    type: 'flight' | 'hotel' | 'car' | 'train' | 'other';
    title: string;
    reservation_time: string | null;
    reservation_end_time: string | null;
    location: string | null;
    confirmation_number: string | null;
    provider: string | null;
    passenger_names: string[];
    legs: Array<{ /* per schema */ }>;
    notes: string | null;
    price: number | null;
    currency: string | null;
  };
  confidence: number;           // 0..1
  provider_used: 'ollama' | 'anthropic' | 'openai';
  attached_file_id: number | null;
}
// 400 validation; 409 IMPORT_DISABLED; 502 PROVIDER_ERROR (row still written status='failed'); 504 PROVIDER_TIMEOUT.
```

**Authorization:** `authenticate` + `requireTripAccess` + `checkPermission('reservation_edit', ...)`. Reuse the reservation-edit permission — if a user can create reservations, they can import.

**Thin controller / fat service:** route does multer parsing + permission check + delegates.

**Rate limiting:** rely on global limiter for now. TODO comment for per-route limit if abuse appears.

**WebSocket:** **no broadcast.** Quiet synchronous RPC for the initiating user only. The subsequent reservation `POST` broadcasts normally.

**Tests:**
- Integration: 401 without auth; 403 for non-member; 409 when disabled; happy path with Ollama mocked + fixture PDF returns well-typed draft + writes row.
- Unit: validation rejects empty payload.

**Dependencies:** none new.

**Upstream contribution stance:** Upstreamable after slice 4 and a couple of weeks of real-world use.

---

### Slice 4 — Reservation modal "Import from document/email" flow

**Files added:**
- `client/src/components/Planner/ReservationImportSheet.tsx` — modal-within-modal. Tabs: "Upload PDF" (drop zone, 44×44 targets) and "Paste email text" (textarea). Extract button → callback prefills parent `ReservationModal`.
- `client/src/types/reservationImport.ts` — TS types mirroring server response.

**Files modified:**
- `client/src/api/client.ts` ⚠️ — `reservationImportsApi.extract(tripId, { file?, emailText?, autoAttach? })`. Upstream-active file.
- `client/src/components/Planner/ReservationModal.tsx` ⚠️ — add "Import from document/email" button, open sheet, accept draft, prefill form, mark auto-filled fields with `(auto-filled)` pill via a new local `autoFilledFields: Set<string>`. Upstream moderate churn — keep diff minimal (one button + one handler + one pill span).
- `client/src/i18n/translations/en.ts` (+ minimally `de.ts`) — `reservations.import.*` keys.

**Tests:** frontend tests optional per CLAUDE.md §2.4. Minimum: run end-to-end on a real PDF before declaring slice done.

**Dependencies:** none.

**Upstream contribution stance:** Yes. Component is generic; strings are i18n-routed.

---

### Slice 5 — Anthropic + OpenAI fallback adapters

**Files added:**
- `server/src/services/reservationImport/providers/anthropicProvider.ts` — `@anthropic-ai/sdk` with tool-use JSON-schema constraining.
- `server/src/services/reservationImport/providers/openaiProvider.ts` — `openai` SDK with `response_format: { type: 'json_schema', ... }`.
- Unit tests for each with mocked SDK.

**Files modified:**
- `server/src/services/reservationImport/extractor.ts` — provider dispatch based on admin setting.

**Dependencies** (`server/`): `@anthropic-ai/sdk`, `openai`.

**Upstream contribution stance:** Yes, with caveat — upstream may prefer a plugin-registry pattern. Offer both in the PR.

---

### Slice 6 — OCR fallback + flight-leg normalisation

**Files added:**
- `server/src/services/reservationImport/ocrExtractor.ts` — `tesseract.js` wrapper. Runs only when `import_ocr_enabled === true` AND `pdfTextExtractor` returned `hadText === false` (or text < 100 chars). Caches the worker.
- `server/src/services/reservationImport/legNormaliser.ts` — if `type === 'flight'` and `legs.length > 1`, store legs as `metadata.legs` on the single reservation. If `legs.length === 1`, flatten back to top-level `reservation_time`.
- `client/src/components/Planner/FlightLegsEditor.tsx` — small repeating-block editor for legs.

**Files modified:**
- `server/src/services/reservationImport/extractor.ts` — wire OCR + normaliser.
- `client/src/components/Planner/ReservationModal.tsx` ⚠️ — collapsed-by-default legs UI for type=flight. Upstream moderate risk.

**Dependencies** (`server/`): `tesseract.js` — ~10 MB, lazy-loaded.

**Upstream contribution stance:** OCR yes. Legs-as-metadata: offer both approaches in a discussion issue before a PR.

---

## 3. Key architectural choices (called out)

- **Where Ollama runs.** Separate process, same machine, HTTP. Native Windows install. Admins can point `import_ollama_url` at a LAN host.
- **Provider / model config.** Admin-panel setting (global), encrypted at rest for API keys. Not per-user. Mirrors OIDC pattern.
- **Where the draft lives.** Server-side in `reservation_imports`, returned inline to client. Row is audit/retry record. `reservation_id` is populated on save via either a subsequent `PATCH` or the reservation `POST` handler when an `import_id` is present in the body.
- **Prompt engineering.** JSON-schema-constrained output via Ollama's `format`, OpenAI's `response_format.json_schema`, Anthropic's tool-use. Fall back to free-text-then-parse only if the adapter layer throws `UNSUPPORTED_STRUCTURED_OUTPUT`.
- **OCR.** Gated to slice 6. MVP ships without. Admin toggle off by default.
- **WebSocket.** No broadcast on extract. Normal `reservation:created` fires when the user saves.

---

## 4. Open questions

### Must decide before coding starts

1. **UUID vs INTEGER for `reservation_imports.id`.** CLAUDE.md §9 mandates UUIDs for new tables; the rest of the schema uses integer autoincrement. Plan uses UUID (TEXT) for consistency with §9, which is internally isolated. **Confirm the §9 stance, or relax it to "UUIDs only when we need offline export/sync; integers otherwise."** If we keep the rule, future UUID-keyed reservation joins become messy.
2. **Do we ship slice 1 without a working LLM?** Slice 1 alone adds admin settings + a table but no usable feature. Ship it as a preparatory PR, or collapse 1+2 into one commit? Depends on how much merge pain upstream rebasing causes.
3. **`client_mutation_id` dedup now or at Milestone 4.** The plan records the header but doesn't enforce idempotency yet. Since `POST /extract` is a billable LLM call on slice 5+, enforcing dedup now (uniqueness index on `reservation_imports.client_mutation_id`) may be worth the small cost.
4. **Multi-leg flights: one reservation or N?** Plan picks one reservation with `metadata.legs[]` (smaller change). Alternative: N reservations with `parent_reservation_id` (each leg gets its own day/time slot and reminders). **Decide before slice 6.**
5. **Auto-attach PDF default.** Plan defaults `auto_attach=true` (confirmation PDF ends up in Documents tab). Alternative: explicit opt-in each time. Auto-attach + "user can delete from review form" matches the "single flow" hint in CLAUDE.md §6.

### Can decide during

6. **Ollama model default.** `llama3.1:8b` (plan). Alternatives: `mistral:7b`, `qwen2.5:7b`. Try real PDFs and pick the most accurate.
7. **Max PDF size.** 10 MB (plan). Airline PDFs are < 1 MB typically; travel-agent itineraries can hit 5-10 MB.
8. **Confidence source.** Model self-report + heuristic (all required fields present = 0.9, scaled down per missing field). Iterate in slice 4.
9. **Audit-row retention.** Plan keeps forever. Consider nightly purge of `status='applied'` older than 90 days. Not needed day one.
10. **Client-side validation of the draft.** LLM may produce invalid ISO timestamps. Zod-parse the response client-side, log warnings, don't reject.
11. **Attribution line.** Small "Powered by Ollama / Claude / GPT-4o-mini" note in the review form helps gauge trust.
12. **Language detection.** Multilingual model handles German booking.com PDFs fine. Log detected language on the audit row for post-hoc analysis.

---

## 5. Environment prerequisites

- **Docker:** not required for this milestone.
- **Ollama:**
  - `winget install Ollama.Ollama` (or installer from ollama.com).
  - `ollama pull llama3.1:8b` (~4.7 GB, one-time).
  - `ollama serve` runs as a Windows service; check `http://localhost:11434/api/tags`.
  - Document the install in `docs/ours-smart-import.md` as part of slice 1.
- **External API keys (Anthropic, OpenAI):** fully optional. Default `import_provider = 'disabled'`. Feature is usable with Ollama alone. Provider set without a key → endpoint returns 409 with clear message.
- **`ENCRYPTION_KEY`:** already present in baseline server.

---

## 6. Upstream contribution stance (summary)

| Slice | Upstream? | Notes |
|---|---|---|
| 1 — table + admin settings | No, fork-only for now. | Configuration schema. Wait until slices 2-4 prove the UX. |
| 2 — extraction service | Yes eventually. | Provider-agnostic. |
| 3 — POST /extract endpoint | Yes eventually. | Generic. |
| 4 — reservation-modal UI | Yes eventually. | Additive; i18n-clean. |
| 5 — Anthropic/OpenAI adapters | Yes eventually with discussion. | Upstream may prefer a plugin-registry pattern. |
| 6 — OCR + leg normalisation | Partial. OCR yes; leg-as-metadata needs design discussion. |

Open a GitHub Discussion on `mauriceboe/TREK` after slice 4 lands on `personal` and you've used it on a real booking. Do NOT open PRs before that — bake on our fork for 2-3 weeks minimum.

---

## Critical files for implementation

- `server/src/db/migrations.ts` — append new migration (slice 1).
- `server/src/routes/admin.ts` — add `/import-settings` routes (slice 1).
- `server/src/services/adminService.ts` — mirror OIDC pattern at lines 238-266 (slice 1). Preferred: keep in new `importSettingsService.ts` instead.
- `server/src/app.ts` — mount new `reservationImport` route (slice 3).
- `client/src/components/Planner/ReservationModal.tsx` — add Import button + accept prefill (slice 4).
