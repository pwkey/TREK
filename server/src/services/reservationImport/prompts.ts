export function buildExtractionPrompt(rawText: string): string {
  const trimmed = rawText.trim().slice(0, 60_000);
  return [
    'You extract structured travel reservation details from raw booking text.',
    '',
    'Rules:',
    '- Output MUST match the provided JSON schema exactly. Do not include extra fields.',
    '- Unknown values: set the field to null (or an empty array for list fields).',
    '- Dates and times: emit ISO 8601 strings including timezone when present (e.g. "2026-07-15T09:15:00+02:00"). If timezone is missing, emit without timezone (naive ISO).',
    '- `type`: pick the best of "flight" | "hotel" | "car" | "train" | "other".',
    '- `title`: concise human summary ("QF9 SYD → LHR", "Hilton Paris Opera, 3 nights").',
    '- `reservation_time` / `reservation_end_time`: for flights use first leg departure and last leg arrival; for hotels use check-in and check-out; for cars use pick-up and return.',
    '- `legs[]`: populate only for `type === "flight"` with one entry per leg; empty array for other types.',
    '- `confirmation_number`: carrier/PNR/booking reference; exclude spaces.',
    '- `passenger_names[]`: names as printed on the booking; empty array if none are shown.',
    '- `price` and `currency`: emit the total paid amount when visible; otherwise null + null.',
    '',
    'Booking text:',
    '---',
    trimmed,
    '---',
    '',
    'Respond with a single JSON object that conforms to the schema.',
  ].join('\n');
}
