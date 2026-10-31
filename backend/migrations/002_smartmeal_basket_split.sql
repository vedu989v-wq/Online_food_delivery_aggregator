CREATE TABLE IF NOT EXISTS smartmeal_health_profiles (
  user_id uuid PRIMARY KEY REFERENCES customer_users(id) ON DELETE CASCADE,
  consented boolean NOT NULL DEFAULT false,
  age_years smallint,
  height_cm numeric(5,2),
  weight_kg numeric(5,2),
  activity_level text CHECK (activity_level IS NULL OR activity_level IN ('sedentary','light','moderate','active','very_active')),
  goal text CHECK (goal IS NULL OR goal IN ('maintenance','balanced','muscle_gain','weight_loss','high_protein')),
  dietary_preference text,
  calorie_target integer,
  protein_target_g numeric(6,2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (age_years IS NULL OR age_years BETWEEN 18 AND 120),
  CHECK (height_cm IS NULL OR height_cm BETWEEN 100 AND 250),
  CHECK (weight_kg IS NULL OR weight_kg BETWEEN 25 AND 350),
  CHECK (calorie_target IS NULL OR calorie_target BETWEEN 500 AND 10000),
  CHECK (protein_target_g IS NULL OR protein_target_g BETWEEN 0 AND 500),
  CHECK (consented OR (age_years IS NULL AND height_cm IS NULL AND weight_kg IS NULL AND activity_level IS NULL AND goal IS NULL AND dietary_preference IS NULL AND calorie_target IS NULL AND protein_target_g IS NULL))
);
CREATE TABLE IF NOT EXISTS nutrition_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dish_key text NOT NULL UNIQUE,
  dish_name text NOT NULL,
  serving_size_g numeric(8,2),
  calories_kcal numeric(8,2),
  protein_g numeric(8,2),
  carbohydrates_g numeric(8,2),
  fat_g numeric(8,2),
  fiber_g numeric(8,2),
  sodium_mg numeric(10,2),
  source_name text NOT NULL,
  source_reference text NOT NULL,
  estimation_method text NOT NULL,
  confidence_level text NOT NULL CHECK(confidence_level IN ('high','medium','low')),
  verification_status text NOT NULL CHECK(verification_status IN ('verified','database_derived_estimate','approximate')),
  last_updated timestamptz NOT NULL DEFAULT now(),
  CHECK (serving_size_g IS NULL OR serving_size_g > 0),
  CHECK (calories_kcal IS NULL OR calories_kcal >= 0),
  CHECK (protein_g IS NULL OR protein_g >= 0),
  CHECK (carbohydrates_g IS NULL OR carbohydrates_g >= 0),
  CHECK (fat_g IS NULL OR fat_g >= 0),
  CHECK (fiber_g IS NULL OR fiber_g >= 0),
  CHECK (sodium_mg IS NULL OR sodium_mg >= 0)
);

CREATE TABLE IF NOT EXISTS shared_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  restaurant_id text NOT NULL,
  restaurant_name text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','locked','ordered','cancelled','expired')),
  address_ciphertext text,
  address_confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours')
);
CREATE TABLE IF NOT EXISTS shared_cart_members (
  cart_id uuid NOT NULL REFERENCES shared_carts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('organizer','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  address_confirmed_at timestamptz,
  address_fingerprint char(64),
  PRIMARY KEY(cart_id,user_id)
);
CREATE TABLE IF NOT EXISTS shared_cart_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES shared_carts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES customer_users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shared_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES shared_carts(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  item_id text NOT NULL,
  item_name text NOT NULL,
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(cart_id,owner_id) REFERENCES shared_cart_members(cart_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS shared_cart_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cart_id uuid NOT NULL REFERENCES shared_carts(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES customer_users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shared_cart_events_cursor ON shared_cart_events(cart_id,id);
CREATE TABLE IF NOT EXISTS shared_cart_allocations (
  cart_id uuid NOT NULL REFERENCES shared_carts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  breakdown jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(cart_id,version)
);
CREATE TABLE IF NOT EXISTS shared_cart_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL,
  allocation_version integer NOT NULL,
  user_id uuid NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  provider text NOT NULL,
  provider_reference text,
  status text NOT NULL DEFAULT 'unconfigured' CHECK(status IN ('unconfigured','pending','paid','failed','expired','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(cart_id,allocation_version) REFERENCES shared_cart_allocations(cart_id,version),
  FOREIGN KEY(cart_id,user_id) REFERENCES shared_cart_members(cart_id,user_id),
  UNIQUE(cart_id,allocation_version,user_id)
);
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  entity_id text,
  processing_status text NOT NULL DEFAULT 'received' CHECK(processing_status IN ('received','processed','ignored')),
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
