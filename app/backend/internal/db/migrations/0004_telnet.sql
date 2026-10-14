-- Telnet connections (unencrypted; for network equipment without SSH) and a
-- "network device" type for switches, routers and similar appliances.
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_protocol_check;
ALTER TABLE connections ADD CONSTRAINT connections_protocol_check CHECK (protocol IN ('rdp', 'vnc', 'ssh', 'telnet'));
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_type_check;
ALTER TABLE devices ADD CONSTRAINT devices_device_type_check
    CHECK (device_type IN ('desktop', 'laptop', 'server', 'virtual_machine', 'network', 'other'));
