-- Switches, routers and firewalls are a kind of device of their own.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_os_check;
ALTER TABLE devices ADD CONSTRAINT devices_os_check CHECK (os IN ('windows', 'macos', 'linux', 'network', 'other'));
