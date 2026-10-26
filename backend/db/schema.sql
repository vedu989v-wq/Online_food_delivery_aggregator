-- PostgreSQL target schema. Apply only when you are ready to replace the in-memory MVP store.
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, trust_weight NUMERIC(4,3) NOT NULL CHECK (trust_weight BETWEEN 0 AND 1)
);
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, area TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  phone TEXT, cuisines JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_listings (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), provider_record_id TEXT NOT NULL,
  restaurant_id TEXT REFERENCES restaurants(id), source_name TEXT NOT NULL, address TEXT, raw_payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL, UNIQUE(provider_id, provider_record_id), UNIQUE(restaurant_id, provider_id)
);
CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES provider_listings(id), attribute TEXT NOT NULL,
  value JSONB, observed_at TIMESTAMPTZ NOT NULL, confidence NUMERIC(4,3), validation_status TEXT NOT NULL DEFAULT 'valid'
);
CREATE INDEX IF NOT EXISTS observations_latest_idx ON observations(listing_id, attribute, observed_at DESC);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES provider_listings(id), text TEXT NOT NULL,
  text_hash TEXT NOT NULL, rating NUMERIC(2,1), created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reviews_hash_idx ON reviews(text_hash);
CREATE TABLE IF NOT EXISTS review_aspects (
  id BIGSERIAL PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), aspect TEXT NOT NULL,
  sentiment NUMERIC(4,3), model_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entity_match_candidates (
  id TEXT PRIMARY KEY, left_listing_id TEXT NOT NULL REFERENCES provider_listings(id),
  right_listing_id TEXT NOT NULL REFERENCES provider_listings(id), score NUMERIC(5,4) NOT NULL,
  signals JSONB NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','merged','rejected')), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reconciliation_events (
  id BIGSERIAL PRIMARY KEY, candidate_id TEXT REFERENCES entity_match_candidates(id), verdict TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'demo-admin', rationale TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_preferences (
  id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, preferences JSONB NOT NULL DEFAULT '{}',
  analytics_consent BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
