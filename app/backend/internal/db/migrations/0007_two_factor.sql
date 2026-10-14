-- Two-factor authentication (TOTP). The secret is encrypted with the server
-- key (it is needed at sign-in, before the saved-password vault is unlocked).
ALTER TABLE users
    ADD COLUMN totp_enabled     boolean NOT NULL DEFAULT false,
    ADD COLUMN totp_secret_enc  bytea,
    -- A secret being set up; it replaces the active one only once a code from it is confirmed.
    ADD COLUMN totp_pending_enc bytea,
    -- Newest accepted time step, so that a code works only once.
    ADD COLUMN totp_last_step   bigint NOT NULL DEFAULT 0;

CREATE TABLE recovery_codes (
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    used_at   timestamptz,
    PRIMARY KEY (user_id, code_hash)
);
