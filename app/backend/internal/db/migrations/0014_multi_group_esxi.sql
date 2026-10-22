-- A device can belong to several groups. devices.group_id stays as a legacy column (the first group); everything reads
-- the membership table, whose position says which group is the first.
CREATE TABLE device_group_members (
    device_id uuid     NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    group_id  uuid     NOT NULL REFERENCES device_groups (id) ON DELETE CASCADE,
    position  smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, group_id)
);
CREATE INDEX device_group_members_group_idx ON device_group_members (group_id);

INSERT INTO device_group_members (device_id, group_id, position)
SELECT id, group_id, 0 FROM devices WHERE group_id IS NOT NULL;

-- Who sees what: a granted group now reaches every device that is a member of it.
CREATE OR REPLACE FUNCTION emr_visible_devices(uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
    SELECT d.id FROM devices d
    WHERE d.owner_id = uid
       OR (d.owner_id IS NULL AND (
            emr_sees_all_shared(uid)
            OR EXISTS (
                SELECT 1 FROM access_grants g JOIN users u ON u.id = uid
                WHERE (g.user_id = u.id OR (g.team_id IS NOT NULL AND g.team_id = u.team_id))
                  AND (g.device_id = d.id
                       OR (g.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id = d.id AND m.group_id = g.group_id))))))
$$;

CREATE OR REPLACE FUNCTION emr_visible_groups(uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
    SELECT g.id FROM device_groups g
    WHERE g.owner_id = uid
       OR (g.owner_id IS NULL AND (
            emr_sees_all_shared(uid)
            OR EXISTS (
                SELECT 1 FROM access_grants a JOIN users u ON u.id = uid
                WHERE a.group_id = g.id AND (a.user_id = u.id OR (a.team_id IS NOT NULL AND a.team_id = u.team_id)))
            OR EXISTS (SELECT 1 FROM device_group_members m WHERE m.group_id = g.id AND m.device_id IN (SELECT emr_visible_devices(uid)))))
$$;

-- VMware ESXi is an operating system of its own (VMkernel); it has no system overview but gets its own logo.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_os_check;
ALTER TABLE devices ADD CONSTRAINT devices_os_check CHECK (os IN ('windows', 'macos', 'linux', 'network', 'esxi', 'other'));
