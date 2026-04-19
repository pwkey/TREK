# Smart Import — setup and runbook

Milestone 2 of 460 Trip Planner. See `CLAUDE.md` §6 Milestone 2 for the design rationale and `docs/ours-milestone-2-plan.md` for the implementation plan.

**Status as of 2026-04-19:** slices 1 + 2 collapsed and shipped. Admin settings + extraction service (Ollama adapter) are in place; the HTTP endpoint, reservation-modal UI, cloud-provider adapters, and OCR fallback are slices 3–6 and NOT yet implemented.

---

## 1. What's working now

- New SQLite table `reservation_imports` (UUID key, records audit trail for every extraction attempt).
- New admin section "Smart Import" at `/admin` → Smart Import tab. Configure provider, Ollama URL / model, encrypted API keys for Anthropic and OpenAI (adapters arrive in slice 5), OCR fallback toggle (wires in slice 6).
- Extraction service `server/src/services/reservationImport/` — text-layer PDF extraction via `pdf-parse`, Ollama structured-output adapter, zod-validated JSON schema, confidence heuristic.
- API keys are encrypted at rest (`enc:v1:` prefix, AES-256-GCM via `apiKeyCrypto.ts`) and never returned by `GET /api/admin/import-settings` — only a `*_key_set` boolean.

## 2. Installing and running Ollama (development)

Only needed if you want the extraction service to work end-to-end today.

```bash
# Windows
winget install Ollama.Ollama
# macOS
brew install ollama

# Pull a model (one-time, ~4.7 GB for llama3.1:8b)
ollama pull llama3.1:8b

# Verify it's serving
curl http://localhost:11434/api/tags
```

Ollama installs as a service on Windows — no extra `ollama serve` needed after install. On macOS launch the Ollama app once.

**Which model to pick:**

- `llama3.1:8b` (default) — good accuracy, runs on 8–16 GB RAM.
- `mistral:7b` — smaller, faster, slightly less accurate.
- `qwen2.5:7b` — alternative worth trying if Llama misreads layouts.

Any of them support Ollama's `format` parameter for JSON-schema-constrained output, which is how we get structured extraction without post-hoc parsing fragility.

## 3. Configuring the admin panel

1. Log in as an admin at `http://localhost:5173` → `/admin`.
2. Click the "Smart Import" tab.
3. Pick a provider:
   - **Disabled** (default) — no extraction happens.
   - **Ollama (local)** — privacy-preserving, runs on the server machine.
   - **Anthropic API** or **OpenAI API** — adapters ship in slice 5. Setting up a key now is fine; selecting the provider before slice 5 will cause the extract call to error cleanly.
4. Set the Ollama URL (default `http://localhost:11434`) and model (default `llama3.1:8b`). If you're running Ollama on another machine on your LAN, point the URL there.
5. Save.

## 4. Verifying the extraction service (manual)

Until slice 3 wires the HTTP endpoint and slice 4 the UI, the extractor is exercised only via unit tests. To run them:

```bash
cd server
npx vitest run tests/unit/reservationImport tests/integration/importSettings.test.ts
```

Expected: 20/20 green.

## 5. Security and privacy notes

- **Ollama:** nothing leaves the server machine. Booking PDFs, passenger names, confirmation codes all stay local.
- **Anthropic / OpenAI:** booking data transits their API. Only pick these if you're comfortable with the provider's data-retention terms. Both offer zero-retention enterprise tiers; we don't wire those.
- **Admin keys:** stored encrypted (AES-256-GCM, derived from the server's `ENCRYPTION_KEY`). Clearing a key requires an explicit `null` PUT from the admin panel "Clear" button. Never committed to git (`server/data/` is gitignored).

## 6. Merge-conflict hotspots

If we're rebasing on upstream TREK and Smart Import files conflict:

- `server/src/db/migrations.ts` ⚠️ — always keep our migration thunk at the **tail** of the array, renumbering if upstream appended migrations. Commented with `[460-fork] Smart Import (Milestone 2)`.
- `server/src/routes/admin.ts` ⚠️ — additive block at the bottom, clearly commented. Just re-apply after upstream edits.
- `client/src/api/client.ts` ⚠️ — two new entries at the tail of `adminApi`.
- `client/src/pages/AdminPage.tsx` — three small diffs (import, TABS entry, render line).

The rest of our Smart Import code lives in new files upstream doesn't touch:
- `server/src/services/importSettingsService.ts`
- `server/src/services/reservationImport/*`
- `server/tests/integration/importSettings.test.ts`
- `server/tests/unit/reservationImport/*`
- `client/src/components/Admin/SmartImportPanel.tsx`

## 7. Known limitations

- **No HTTP endpoint yet.** Extraction service exists but is unreachable from the client. Coming in slice 3.
- **No UI trigger.** Reservation modal doesn't have the "Import from document/email" button yet. Coming in slice 4.
- **No cloud-provider adapters.** Selecting Anthropic or OpenAI in admin returns `PROVIDER_DISABLED` for now. Coming in slice 5.
- **No OCR fallback.** Image-only PDFs will return empty text. Toggle is wired but non-functional. Coming in slice 6.
- **No flight-leg UI.** Multi-leg flights will extract into `metadata.legs[]` but there's no editor yet. Coming in slice 6.

## 8. Upstream PR candidate

Once slice 4 ships and we've used the feature on a real booking for a couple of weeks, open a GitHub Discussion on `mauriceboe/TREK` to propose upstreaming slices 2–6. Slice 1 (admin settings schema) is fork-specific and unlikely to be upstreamed as-is.
