-- Privileged access vault. Saved credentials become vault entries: they keep their
-- secret_enc (sealed with the vault data key) and gain a kind, folder, tags, access
-- and reveal policies, password rotation settings, a version history, per-user or
-- per-team sharing, access requests and exclusive check-outs.

ALTER TABLE credentials
    ADD COLUMN kind          text    NOT NULL DEFAULT 'login' CHECK (kind IN ('login', 'ssh_key', 'api_token', 'note')),
    ADD COLUMN folder        text    NOT NULL DEFAULT '' CHECK (char_length(folder) <= 128),
    ADD COLUMN tags          text[]  NOT NULL DEFAULT '{}',
    ADD COLUMN url           text    NOT NULL DEFAULT '' CHECK (char_length(url) <= 512),
    ADD COLUMN description   text    NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    -- allowed: people with reveal access may show or copy the secret (with a reason);
    -- never:   the secret is only used to connect, nobody sees it.
    ADD COLUMN reveal_policy text    NOT NULL DEFAULT 'allowed' CHECK (reveal_policy IN ('allowed', 'never')),
    -- open:      use and reveal without a check-out
    -- exclusive: one person at a time, through a time-limited check-out
    -- approval:  like exclusive, but members need an approved request first
    ADD COLUMN access_policy text    NOT NULL DEFAULT 'open' CHECK (access_policy IN ('open', 'exclusive', 'approval')),
    ADD COLUMN max_checkout_minutes int NOT NULL DEFAULT 60 CHECK (max_checkout_minutes BETWEEN 5 AND 1440),
    -- Emergency access: check out without approval, with a reason, loudly audited.
    ADD COLUMN break_glass   boolean NOT NULL DEFAULT true,
    -- Rotation: the SSH connection used to change the password on the target.
    ADD COLUMN rotation_connection_id uuid REFERENCES connections (id) ON DELETE SET NULL,
    ADD COLUMN rotate_after_checkin   boolean NOT NULL DEFAULT false,
    -- Change the password every N days (0 = never). Without a rotation connection the
    -- entry is only marked as overdue.
    ADD COLUMN rotation_interval_days int NOT NULL DEFAULT 0 CHECK (rotation_interval_days BETWEEN 0 AND 3650),
    ADD COLUMN secret_changed_at timestamptz,
    ADD COLUMN rotated_at        timestamptz,
    ADD COLUMN rotation_status   text NOT NULL DEFAULT '' CHECK (rotation_status IN ('', 'ok', 'unverified', 'failed')),
    ADD COLUMN rotation_error    text NOT NULL DEFAULT '',
    -- 0 (very weak) .. 4 (strong), computed when the password is saved; NULL without a password.
    ADD COLUMN password_strength smallint;

-- Existing credentials were promised to be write-only: keep them that way until an
-- administrator decides otherwise.
UPDATE credentials SET reveal_policy = 'never', secret_changed_at = updated_at;
CREATE INDEX credentials_rotation_conn_idx ON credentials (rotation_connection_id);

-- Every saved value of a secret, newest first. secret_enc is sealed with the vault
-- data key and bound to the version row.
CREATE TABLE credential_versions (
    id            uuid PRIMARY KEY,
    credential_id uuid NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
    secret_enc    bytea NOT NULL,
    secret_fields text[] NOT NULL DEFAULT '{}',
    -- saved: typed in a form; rotated: changed on the target by emremote; restored: an
    -- older version made current again; attempt: a rotation whose outcome is unknown.
    source        text NOT NULL CHECK (source IN ('saved', 'rotated', 'restored', 'attempt')),
    actor_name    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credential_versions_cred_idx ON credential_versions (credential_id, created_at DESC);

-- Shared vault entries granted to members or teams.
--   use:    see the entry, check it out and connect with it
--   reveal: also show or copy the secret (if the entry allows revealing)
CREATE TABLE vault_grants (
    credential_id uuid NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
    user_id       uuid REFERENCES users (id) ON DELETE CASCADE,
    team_id       uuid REFERENCES teams (id) ON DELETE CASCADE,
    level         text NOT NULL CHECK (level IN ('use', 'reveal')),
    CHECK ((user_id IS NULL) <> (team_id IS NULL))
);
CREATE UNIQUE INDEX vault_grants_unique ON vault_grants (credential_id, COALESCE(user_id, team_id));
CREATE INDEX vault_grants_user_idx ON vault_grants (user_id);
CREATE INDEX vault_grants_team_idx ON vault_grants (team_id);

-- Requests for an entry with the approval policy.
CREATE TABLE vault_requests (
    id              uuid PRIMARY KEY,
    credential_id   uuid NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason          text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
    minutes         int  NOT NULL CHECK (minutes BETWEEN 5 AND 1440),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'used', 'expired')),
    decided_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_by_name text NOT NULL DEFAULT '',
    decision_note   text NOT NULL DEFAULT '' CHECK (char_length(decision_note) <= 500),
    decided_at      timestamptz,
    -- An approval has to be used (checked out) before this time.
    valid_until     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vault_requests_open ON vault_requests (credential_id, user_id) WHERE status IN ('pending', 'approved');
CREATE INDEX vault_requests_status_idx ON vault_requests (status, created_at DESC);

-- Exclusive check-outs. Only one may be open per entry.
CREATE TABLE vault_checkouts (
    id            uuid PRIMARY KEY,
    credential_id uuid NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
    user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
    username      text NOT NULL,
    request_id    uuid REFERENCES vault_requests (id) ON DELETE SET NULL,
    reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
    break_glass   boolean NOT NULL DEFAULT false,
    started_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    checked_in_at timestamptz,
    -- Who ended it: a username, or "expired" when the time ran out.
    checked_in_by text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX vault_checkouts_active ON vault_checkouts (credential_id) WHERE checked_in_at IS NULL;
CREATE INDEX vault_checkouts_cred_idx ON vault_checkouts (credential_id, started_at DESC);
