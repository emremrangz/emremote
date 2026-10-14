-- emremote initial schema.

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username            text NOT NULL CHECK (char_length(username) BETWEEN 1 AND 64),
    password_hash       text NOT NULL,
    -- Only 'admin' exists in the first release; the column keeps RBAC additive.
    role                text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    last_login_at       timestamptz
);
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));

-- Browser sessions. The id is the SHA-256 of the cookie token; the raw token
-- is never stored.
CREATE TABLE sessions (
    id           text PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf_token   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    ip           text NOT NULL DEFAULT '',
    user_agent   text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE device_groups (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    description text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_groups_name_lower_key ON device_groups (lower(name));

CREATE TABLE devices (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
    hostname         text NOT NULL DEFAULT '',
    address          text NOT NULL,
    os               text NOT NULL CHECK (os IN ('windows', 'macos', 'linux', 'other')),
    device_type      text NOT NULL DEFAULT 'desktop'
                     CHECK (device_type IN ('desktop', 'laptop', 'server', 'virtual_machine', 'other')),
    description      text NOT NULL DEFAULT '',
    notes            text NOT NULL DEFAULT '',
    tags             text[] NOT NULL DEFAULT '{}',
    group_id         uuid REFERENCES device_groups (id) ON DELETE SET NULL,
    favorite         boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    last_accessed_at timestamptz
);
CREATE INDEX devices_group_id_idx ON devices (group_id);
CREATE INDEX devices_tags_idx ON devices USING gin (tags);

-- Reusable stored credentials. Secret material lives only in secret_enc,
-- encrypted with AES-256-GCM by the application (see internal/secrets).
CREATE TABLE credentials (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
    username      text NOT NULL DEFAULT '',
    domain        text NOT NULL DEFAULT '',
    secret_enc    bytea,
    -- Names of the fields present in secret_enc (e.g. {password,private_key});
    -- lets the API report what is stored without decrypting it.
    secret_fields text[] NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX credentials_name_lower_key ON credentials (lower(name));

-- Connection profiles: how to reach a device with a given protocol.
CREATE TABLE connections (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id         uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
    protocol          text NOT NULL CHECK (protocol IN ('rdp', 'vnc', 'ssh')),
    port              integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username          text NOT NULL DEFAULT '',
    domain            text NOT NULL DEFAULT '',
    credential_id     uuid REFERENCES credentials (id) ON DELETE SET NULL,
    secret_enc        bytea,
    secret_fields     text[] NOT NULL DEFAULT '{}',
    settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    last_used_at      timestamptz,
    -- Result of the most recent TCP reachability probe (NULL = never checked).
    status_reachable  boolean,
    status_checked_at timestamptz,
    status_detail     text NOT NULL DEFAULT ''
);
CREATE INDEX connections_device_id_idx ON connections (device_id);
CREATE INDEX connections_credential_id_idx ON connections (credential_id);

CREATE TABLE audit_events (
    id            bigserial PRIMARY KEY,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    actor_name    text NOT NULL DEFAULT '',
    action        text NOT NULL,
    target_type   text NOT NULL DEFAULT '',
    target_id     text NOT NULL DEFAULT '',
    target_name   text NOT NULL DEFAULT '',
    ip            text NOT NULL DEFAULT '',
    success       boolean NOT NULL DEFAULT true,
    details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id);

