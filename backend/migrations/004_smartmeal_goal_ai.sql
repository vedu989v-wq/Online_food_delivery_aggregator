ALTER TABLE smartmeal_health_profiles ADD COLUMN IF NOT EXISTS target_weight_kg numeric(5,2);
ALTER TABLE smartmeal_health_profiles ADD COLUMN IF NOT EXISTS exercise_days_per_week smallint;
ALTER TABLE smartmeal_health_profiles DROP CONSTRAINT IF EXISTS smartmeal_health_profiles_goal_check;
ALTER TABLE smartmeal_health_profiles ADD CONSTRAINT smartmeal_health_profiles_goal_check
  CHECK (goal IS NULL OR goal IN ('weight_gain','maintenance','balanced','muscle_gain','weight_loss','high_protein'));
ALTER TABLE smartmeal_health_profiles ADD CONSTRAINT smartmeal_health_profiles_target_weight_check
  CHECK (target_weight_kg IS NULL OR target_weight_kg BETWEEN 25 AND 350);
ALTER TABLE smartmeal_health_profiles ADD CONSTRAINT smartmeal_health_profiles_exercise_days_check
  CHECK (exercise_days_per_week IS NULL OR exercise_days_per_week BETWEEN 0 AND 14);
ALTER TABLE smartmeal_health_profiles ADD CONSTRAINT smartmeal_health_profiles_consent_fields_check
  CHECK (consented OR (target_weight_kg IS NULL AND exercise_days_per_week IS NULL));
ALTER TABLE nutrition_records ADD COLUMN IF NOT EXISTS nutrition_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE nutrition_records ADD COLUMN IF NOT EXISTS source_menu_key text;
ALTER TABLE nutrition_records ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'approved';
ALTER TABLE nutrition_records ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES customer_users(id) ON DELETE SET NULL;
ALTER TABLE nutrition_records ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE nutrition_records ADD CONSTRAINT nutrition_records_review_status_check
  CHECK (review_status IN ('pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS nutrition_records_source_menu_key ON nutrition_records(source_menu_key);
CREATE INDEX IF NOT EXISTS nutrition_records_pending_review ON nutrition_records(review_status) WHERE review_status='pending';
