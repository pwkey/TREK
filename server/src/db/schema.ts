import Database from 'better-sqlite3';

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      maps_api_key TEXT,
      unsplash_api_key TEXT,
      openweather_api_key TEXT,
      avatar TEXT,
      oidc_sub TEXT,
      oidc_issuer TEXT,
      last_login DATETIME,
      mfa_enabled INTEGER DEFAULT 0,
      mfa_secret TEXT,
      mfa_backup_codes TEXT,
      immich_url TEXT,
      immich_access_token TEXT,
      synology_url TEXT,
      synology_username TEXT,
      synology_password TEXT,
      synology_sid TEXT,
      must_change_password INTEGER DEFAULT 0,
      household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- [460-fork] Milestone 11: index on users.household_id lives in the
    -- migration ONLY (same reasoning as days.segment_id at line ~109).
    -- On a fresh install the CREATE TABLE above creates the column and the
    -- migration's CREATE INDEX IF NOT EXISTS is a harmless no-op. On an
    -- EXISTING install the CREATE TABLE IF NOT EXISTS is a no-op (the column
    -- doesn't exist yet — it's added by the M11 migration), so indexing it
    -- HERE crashes boot with "no such column: household_id". The migration
    -- adds the column first, THEN the index. Do NOT re-add an index line here.
    -- [460-fork] Milestone 11 — Household supersedes M3 partner pairing.
    -- N user accounts + M named non-account members in one group. Replaces
    -- the 1-to-1 partner_user_id symmetric pair.
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS household_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      dob TEXT,
      relationship TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_household_members_household ON household_members(household_id);
    CREATE TABLE IF NOT EXISTS household_invites (
      id TEXT PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      invitee_email TEXT NOT NULL,
      invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      expires_at DATETIME NOT NULL,
      responded_at DATETIME,
      client_mutation_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_household_invites_household ON household_invites(household_id, status);
    CREATE INDEX IF NOT EXISTS idx_household_invites_email ON household_invites(LOWER(invitee_email), status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_household_invites_cmid
      ON household_invites(client_mutation_id) WHERE client_mutation_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT,
      end_date TEXT,
      currency TEXT DEFAULT 'EUR',
      cover_image TEXT,
      is_archived INTEGER DEFAULT 0,
      reminder_days INTEGER DEFAULT 3,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_number INTEGER NOT NULL,
      date TEXT,
      notes TEXT,
      title TEXT,
      segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL, -- [460-fork] Milestone 4
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- [460-fork] Milestone 5 slice 4
      UNIQUE(trip_id, day_number)
    );
    -- [460-fork] Milestone 4: index on segment_id lives in migration 118 only.
    -- On a fresh install the CREATE TABLE above creates the column and the
    -- migration's CREATE INDEX IF NOT EXISTS is a no-op afterwards. On an
    -- existing install the CREATE TABLE IF NOT EXISTS is a no-op (column
    -- doesn't exist yet) and indexing it here would crash; migration 118
    -- runs first an ALTER to add the column, then the index.

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      icon TEXT DEFAULT '📍',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#10b981',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      lat REAL,
      lng REAL,
      address TEXT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      price REAL,
      currency TEXT,
      reservation_status TEXT DEFAULT 'none',
      reservation_notes TEXT,
      reservation_datetime TEXT,
      place_time TEXT,
      end_time TEXT,
      duration_minutes INTEGER DEFAULT 60,
      notes TEXT,
      image_url TEXT,
      google_place_id TEXT,
      website TEXT,
      phone TEXT,
      transport_mode TEXT DEFAULT 'walking',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS place_tags (
      place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (place_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS day_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      order_index INTEGER DEFAULT 0,
      notes TEXT,
      reservation_status TEXT DEFAULT 'none',
      reservation_notes TEXT,
      reservation_datetime TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS packing_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      checked INTEGER DEFAULT 0,
      category TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
      place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      caption TEXT,
      taken_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trip_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
      reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
      place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
      assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      accommodation_id TEXT,
      reservation_time TEXT,
      reservation_end_time TEXT,
      location TEXT,
      confirmation_number TEXT,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      type TEXT DEFAULT 'other',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- [460-fork] Milestone 13: co-edit stale-write precondition
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL -- [460-fork] Milestone 13
    );

    CREATE TABLE IF NOT EXISTS trip_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by INTEGER REFERENCES users(id),
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(trip_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS day_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      time TEXT,
      icon TEXT DEFAULT '📝',
      sort_order REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS budget_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'Other',
      name TEXT NOT NULL,
      total_price REAL NOT NULL DEFAULT 0,
      persons INTEGER DEFAULT NULL,
      days INTEGER DEFAULT NULL,
      note TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Addon system
    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'global',
      icon TEXT DEFAULT 'Puzzle',
      enabled INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS photo_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT DEFAULT 'Image',
      enabled INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS photo_provider_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL REFERENCES photo_providers(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      input_type TEXT NOT NULL DEFAULT 'text',
      placeholder TEXT,
      required INTEGER DEFAULT 0,
      secret INTEGER DEFAULT 0,
      settings_key TEXT,
      payload_key TEXT,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(provider_id, field_key)
    );

    -- Vacay addon tables
    CREATE TABLE IF NOT EXISTS vacay_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      block_weekends INTEGER DEFAULT 1,
      holidays_enabled INTEGER DEFAULT 0,
      holidays_region TEXT DEFAULT '',
      company_holidays_enabled INTEGER DEFAULT 1,
      carry_over_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id)
    );

    CREATE TABLE IF NOT EXISTS vacay_plan_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(plan_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS vacay_user_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      color TEXT DEFAULT '#6366f1',
      UNIQUE(user_id, plan_id)
    );

    CREATE TABLE IF NOT EXISTS vacay_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      UNIQUE(plan_id, year)
    );

    CREATE TABLE IF NOT EXISTS vacay_user_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      vacation_days INTEGER DEFAULT 30,
      carried_over INTEGER DEFAULT 0,
      UNIQUE(user_id, plan_id, year)
    );

    CREATE TABLE IF NOT EXISTS vacay_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      UNIQUE(user_id, plan_id, date)
    );

    CREATE TABLE IF NOT EXISTS vacay_company_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      UNIQUE(plan_id, date)
    );

    CREATE TABLE IF NOT EXISTS vacay_holiday_calendars (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id   INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      region    TEXT NOT NULL,
      label     TEXT,
      color     TEXT NOT NULL DEFAULT '#fecaca',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS day_accommodations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      start_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      end_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      check_in TEXT,
      check_out TEXT,
      confirmation TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Collab addon tables
    CREATE TABLE IF NOT EXISTS collab_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT DEFAULT 'General',
      title TEXT NOT NULL,
      content TEXT,
      color TEXT DEFAULT '#6366f1',
      pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collab_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      multiple INTEGER DEFAULT 0,
      closed INTEGER DEFAULT 0,
      deadline TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collab_poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL REFERENCES collab_polls(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(poll_id, user_id, option_index)
    );

    CREATE TABLE IF NOT EXISTS collab_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      reply_to INTEGER REFERENCES collab_messages(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_collab_notes_trip ON collab_notes(trip_id);
    CREATE INDEX IF NOT EXISTS idx_collab_polls_trip ON collab_polls(trip_id);
    CREATE INDEX IF NOT EXISTS idx_collab_messages_trip ON collab_messages(trip_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_places_trip_id ON places(trip_id);
    CREATE INDEX IF NOT EXISTS idx_places_category_id ON places(category_id);
    CREATE INDEX IF NOT EXISTS idx_days_trip_id ON days(trip_id);
    CREATE INDEX IF NOT EXISTS idx_day_assignments_day_id ON day_assignments(day_id);
    CREATE INDEX IF NOT EXISTS idx_day_assignments_place_id ON day_assignments(place_id);
    CREATE INDEX IF NOT EXISTS idx_place_tags_place_id ON place_tags(place_id);
    CREATE INDEX IF NOT EXISTS idx_place_tags_tag_id ON place_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_trip_members_trip_id ON trip_members(trip_id);
    CREATE INDEX IF NOT EXISTS idx_trip_members_user_id ON trip_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_packing_items_trip_id ON packing_items(trip_id);
    CREATE INDEX IF NOT EXISTS idx_budget_items_trip_id ON budget_items(trip_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_trip_id ON reservations(trip_id);
    CREATE INDEX IF NOT EXISTS idx_trip_files_trip_id ON trip_files(trip_id);
    CREATE INDEX IF NOT EXISTS idx_day_notes_day_id ON day_notes(day_id);
    CREATE INDEX IF NOT EXISTS idx_photos_trip_id ON photos(trip_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_day_accommodations_trip_id ON day_accommodations(trip_id);

    CREATE TABLE IF NOT EXISTS assignment_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL REFERENCES day_assignments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(assignment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assignment_participants_assignment ON assignment_participants(assignment_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      resource TEXT,
      details TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('simple', 'boolean', 'navigate')),
      scope TEXT NOT NULL CHECK(scope IN ('trip', 'user', 'admin')),
      target INTEGER NOT NULL,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title_key TEXT NOT NULL,
      title_params TEXT DEFAULT '{}',
      text_key TEXT NOT NULL,
      text_params TEXT DEFAULT '{}',
      positive_text_key TEXT,
      negative_text_key TEXT,
      positive_callback TEXT,
      negative_callback TEXT,
      response TEXT CHECK(response IN ('positive', 'negative')),
      navigate_text_key TEXT,
      navigate_target TEXT,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, is_read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS notification_channel_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, event_type, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_ncp_user ON notification_channel_preferences(user_id);

    -- [460-fork] Shared segments (Milestone 4) — BEGIN
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_segments_created_by ON segments(created_by);

    CREATE TABLE IF NOT EXISTS trip_segments (
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      is_home INTEGER NOT NULL DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      joined_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      PRIMARY KEY (trip_id, segment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trip_segments_segment ON trip_segments(segment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_segments_home
      ON trip_segments(segment_id) WHERE is_home = 1;

    CREATE TABLE IF NOT EXISTS segment_invites (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME,
      accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_segment_invites_segment ON segment_invites(segment_id);
    -- [460-fork] Shared segments (Milestone 4) — END

    -- [460-fork] Segment document-sharing (Milestone 13) — BEGIN
    -- Opt-in bridge: a reservation/file is private to its trip by default; the
    -- owner may explicitly share it into a segment, making it visible (and, for
    -- reservations, co-editable) to every trip linked to that segment. UNIQUE
    -- guards duplicate shares; ON DELETE CASCADE cleans up when the segment,
    -- reservation, or file goes away.
    CREATE TABLE IF NOT EXISTS segment_shared_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      shared_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(segment_id, reservation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ssr_segment ON segment_shared_reservations(segment_id);
    CREATE INDEX IF NOT EXISTS idx_ssr_reservation ON segment_shared_reservations(reservation_id);

    CREATE TABLE IF NOT EXISTS segment_shared_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      file_id INTEGER NOT NULL REFERENCES trip_files(id) ON DELETE CASCADE,
      shared_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(segment_id, file_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ssf_segment ON segment_shared_files(segment_id);
    CREATE INDEX IF NOT EXISTS idx_ssf_file ON segment_shared_files(file_id);
    -- [460-fork] Segment document-sharing (Milestone 13) — END

    -- [460-fork] Offline-first idempotency (Milestone 5) — BEGIN
    CREATE TABLE IF NOT EXISTS client_mutations (
      client_mutation_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, client_mutation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_client_mutations_created ON client_mutations(created_at);

    CREATE TABLE IF NOT EXISTS client_mutation_conflicts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_mutation_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      record_type TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      mine_payload TEXT NOT NULL,
      theirs_snapshot TEXT NOT NULL,
      observed_updated_at TEXT NOT NULL,
      server_updated_at TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_choice TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_mutation_conflicts_user
      ON client_mutation_conflicts(user_id, resolved_at);
    -- [460-fork] Offline-first idempotency (Milestone 5) — END
  `);
}

export { createTables };
