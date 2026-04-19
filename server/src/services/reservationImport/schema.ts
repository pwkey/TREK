import { z } from 'zod';

export const flightLegSchema = z.object({
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  departure_time: z.string().nullable(),
  arrival_time: z.string().nullable(),
  flight_number: z.string().nullable(),
  airline: z.string().nullable(),
  cabin: z.string().nullable(),
});

export const reservationDraftSchema = z.object({
  type: z.enum(['flight', 'hotel', 'car', 'train', 'other']),
  title: z.string(),
  reservation_time: z.string().nullable(),
  reservation_end_time: z.string().nullable(),
  location: z.string().nullable(),
  confirmation_number: z.string().nullable(),
  provider: z.string().nullable(),
  passenger_names: z.array(z.string()),
  legs: z.array(flightLegSchema),
  notes: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
});

export type ReservationDraftParsed = z.infer<typeof reservationDraftSchema>;

// JSON Schema for LLM structured output (Ollama `format`, OpenAI `response_format`, Anthropic tool-use).
// Kept as a literal so we don't depend on zod's JSON-schema converter at module-load time.
export const reservationDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['flight', 'hotel', 'car', 'train', 'other'] },
    title: { type: 'string' },
    reservation_time: { type: ['string', 'null'], description: 'ISO 8601 start time' },
    reservation_end_time: { type: ['string', 'null'], description: 'ISO 8601 end time' },
    location: { type: ['string', 'null'] },
    confirmation_number: { type: ['string', 'null'] },
    provider: { type: ['string', 'null'], description: 'e.g. airline, hotel brand, rail operator' },
    passenger_names: { type: 'array', items: { type: 'string' } },
    legs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          origin: { type: ['string', 'null'] },
          destination: { type: ['string', 'null'] },
          departure_time: { type: ['string', 'null'] },
          arrival_time: { type: ['string', 'null'] },
          flight_number: { type: ['string', 'null'] },
          airline: { type: ['string', 'null'] },
          cabin: { type: ['string', 'null'] },
        },
        required: ['origin', 'destination', 'departure_time', 'arrival_time', 'flight_number', 'airline', 'cabin'],
      },
    },
    notes: { type: ['string', 'null'] },
    price: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
  },
  required: [
    'type', 'title', 'reservation_time', 'reservation_end_time', 'location',
    'confirmation_number', 'provider', 'passenger_names', 'legs',
    'notes', 'price', 'currency',
  ],
} as const;
