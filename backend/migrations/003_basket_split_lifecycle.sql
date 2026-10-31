ALTER TABLE shared_carts
  ADD COLUMN IF NOT EXISTS selected_provider_id text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE shared_carts DROP CONSTRAINT IF EXISTS shared_carts_state_check;
ALTER TABLE shared_carts ADD CONSTRAINT shared_carts_state_check CHECK (state IN (
  'created','inviting','open','address_confirmation','locked','awaiting_payments',
  'partially_paid','paid','ready_for_checkout','checkout_in_progress','reopening','completed',
  'cancelled','expired','payment_failed','ordered'
));

ALTER TABLE shared_cart_items
  ADD COLUMN IF NOT EXISTS unit_price_paise bigint CHECK (unit_price_paise IS NULL OR unit_price_paise >= 0),
  ADD COLUMN IF NOT EXISTS provider_item_name text;

ALTER TABLE shared_cart_payments
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS qr_image_url text;

CREATE INDEX IF NOT EXISTS shared_cart_payments_status ON shared_cart_payments(cart_id,status);
CREATE INDEX IF NOT EXISTS shared_cart_members_user ON shared_cart_members(user_id,cart_id);

-- Existing carts are open in migration 002; old 'ordered' rows remain readable.
