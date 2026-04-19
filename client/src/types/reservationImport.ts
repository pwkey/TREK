export type ReservationImportKind = 'flight' | 'hotel' | 'car' | 'train' | 'other'

export interface ReservationImportLeg {
  origin: string | null
  destination: string | null
  departure_time: string | null
  arrival_time: string | null
  flight_number: string | null
  airline: string | null
  cabin: string | null
}

export interface ReservationImportDraft {
  type: ReservationImportKind
  title: string
  reservation_time: string | null
  reservation_end_time: string | null
  location: string | null
  confirmation_number: string | null
  provider: string | null
  passenger_names: string[]
  legs: ReservationImportLeg[]
  notes: string | null
  price: number | null
  currency: string | null
}

export interface ReservationImportResponse {
  import_id: string
  draft: ReservationImportDraft
  confidence: number
  provider_used: 'ollama' | 'anthropic' | 'openai'
  attached_file_id: number | null
  replayed?: boolean
}
