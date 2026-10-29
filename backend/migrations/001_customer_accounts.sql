CREATE TABLE IF NOT EXISTS customer_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_users_email_length CHECK (length(email) BETWEEN 3 AND 254),
  CONSTRAINT customer_users_name_length CHECK (length(display_name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_users_email_lower_unique ON customer_users (lower(email));

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id uuid PRIMARY KEY REFERENCES customer_users(id) ON DELETE CASCADE,
  city text,
  area text,
  preferred_cuisines text[] NOT NULL DEFAULT '{}',
  vegetarian_only boolean NOT NULL DEFAULT false,
  budget_per_person numeric(10,2),
  priority text NOT NULL DEFAULT 'value' CHECK (priority IN ('value', 'cheapest', 'fastest', 'reliable', 'rated')),
  interaction_consent boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_profiles_city_length CHECK (city IS NULL OR length(city) BETWEEN 1 AND 100),
  CONSTRAINT customer_profiles_area_length CHECK (area IS NULL OR length(area) BETWEEN 1 AND 100),
  CONSTRAINT customer_profiles_budget_positive CHECK (budget_per_person IS NULL OR budget_per_person > 0)
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash char(64) PRIMARY KEY,
  csrf_hash char(64) NOT NULL,
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_sessions_user_expiry ON customer_sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS saved_restaurants (
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  restaurant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, restaurant_id),
  CONSTRAINT saved_restaurants_id_length CHECK (length(restaurant_id) BETWEEN 1 AND 64)
);

CREATE TABLE IF NOT EXISTS customer_interaction_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('restaurant_viewed', 'restaurant_saved', 'comparison_requested', 'recommendation_selected', 'filter_selected')),
  restaurant_id text,
  cuisine text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_interaction_events_user_time ON customer_interaction_events (user_id, created_at DESC);
