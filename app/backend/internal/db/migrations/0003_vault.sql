-- Password vault: the data key that encrypts saved connection secrets, wrapped
-- with a key derived from each user's sign-in password (and the server key).
CREATE TABLE vault_keys (
    user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    salt        bytea NOT NULL,
    kdf_params  text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
