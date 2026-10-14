-- Multi-user support: members, teams, per-user inventories and shared access.
--
-- Ownership model: devices, device groups and credentials have an optional owner.
-- owner_id IS NULL means "shared inventory" (everything that existed before this
-- migration, and everything administrators create). A member's own items carry
-- their user id and are invisible to everyone else.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'));

ALTER TABLE users
    ADD COLUMN disabled       boolean NOT NULL DEFAULT false,
    -- Extra permissions on top of the team's.
    ADD COLUMN permissions    text[]  NOT NULL DEFAULT '{}',
    -- Which part of the shared inventory the user may use:
    --   none     only their own (initially empty) inventory
    --   selected the shared devices and groups granted in access_grants
    --   all      the whole shared inventory
    ADD COLUMN inventory_mode text    NOT NULL DEFAULT 'none' CHECK (inventory_mode IN ('none', 'selected', 'all')),
    ADD COLUMN team_id        uuid;

-- A team bundles permissions and shared-inventory access for several users.
CREATE TABLE teams (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    description    text NOT NULL DEFAULT '',
    permissions    text[] NOT NULL DEFAULT '{}',
    inventory_mode text NOT NULL DEFAULT 'none' CHECK (inventory_mode IN ('none', 'selected', 'all')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_lower_key ON teams (lower(name));
ALTER TABLE users ADD CONSTRAINT users_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE SET NULL;
CREATE INDEX users_team_id_idx ON users (team_id);

-- Shared devices or device groups granted to a user or a team (inventory_mode = 'selected').
CREATE TABLE access_grants (
    id        bigserial PRIMARY KEY,
    user_id   uuid REFERENCES users (id) ON DELETE CASCADE,
    team_id   uuid REFERENCES teams (id) ON DELETE CASCADE,
    device_id uuid REFERENCES devices (id) ON DELETE CASCADE,
    group_id  uuid REFERENCES device_groups (id) ON DELETE CASCADE,
    CHECK ((user_id IS NULL) <> (team_id IS NULL)),
    CHECK ((device_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX access_grants_unique ON access_grants
    (COALESCE(user_id, team_id), COALESCE(device_id, group_id), (user_id IS NULL), (device_id IS NULL));
CREATE INDEX access_grants_device_idx ON access_grants (device_id);
CREATE INDEX access_grants_group_idx ON access_grants (group_id);

ALTER TABLE devices       ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE device_groups ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE credentials   ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX devices_owner_idx ON devices (owner_id);
CREATE INDEX device_groups_owner_idx ON device_groups (owner_id);
CREATE INDEX credentials_owner_idx ON credentials (owner_id);

-- Names are unique within one owner (shared items count as one owner).
DROP INDEX device_groups_name_lower_key;
CREATE UNIQUE INDEX device_groups_owner_name_key
    ON device_groups (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
DROP INDEX credentials_name_lower_key;
CREATE UNIQUE INDEX credentials_owner_name_key
    ON credentials (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Favorites and "last opened" are personal. The old global columns on devices
-- are kept (unused) so that this migration never loses data.
CREATE TABLE device_user_state (
    user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id        uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    favorite         boolean NOT NULL DEFAULT false,
    last_accessed_at timestamptz,
    PRIMARY KEY (user_id, device_id)
);
CREATE INDEX device_user_state_device_idx ON device_user_state (device_id);
INSERT INTO device_user_state (user_id, device_id, favorite, last_accessed_at)
    SELECT u.id, d.id, d.favorite, d.last_accessed_at
    FROM devices d CROSS JOIN (SELECT id FROM users ORDER BY created_at LIMIT 1) u
    WHERE d.favorite OR d.last_accessed_at IS NOT NULL;

-- Visibility rules, in one place. A user sees their own items plus the part of
-- the shared inventory they were given.
CREATE FUNCTION emr_sees_all_shared(uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT u.role = 'admin' OR u.inventory_mode = 'all' OR COALESCE(t.inventory_mode = 'all', false)
                     FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = uid), false)
$$;

CREATE FUNCTION emr_visible_devices(uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
    SELECT d.id FROM devices d
    WHERE d.owner_id = uid
       OR (d.owner_id IS NULL AND (
            emr_sees_all_shared(uid)
            OR EXISTS (
                SELECT 1 FROM access_grants g JOIN users u ON u.id = uid
                WHERE (g.user_id = u.id OR (g.team_id IS NOT NULL AND g.team_id = u.team_id))
                  AND (g.device_id = d.id OR (g.group_id IS NOT NULL AND g.group_id = d.group_id)))))
$$;

CREATE FUNCTION emr_visible_groups(uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
    SELECT g.id FROM device_groups g
    WHERE g.owner_id = uid
       OR (g.owner_id IS NULL AND (
            emr_sees_all_shared(uid)
            OR EXISTS (
                SELECT 1 FROM access_grants a JOIN users u ON u.id = uid
                WHERE a.group_id = g.id AND (a.user_id = u.id OR (a.team_id IS NOT NULL AND a.team_id = u.team_id)))
            OR EXISTS (SELECT 1 FROM devices d WHERE d.group_id = g.id AND d.id IN (SELECT emr_visible_devices(uid)))))
$$;
