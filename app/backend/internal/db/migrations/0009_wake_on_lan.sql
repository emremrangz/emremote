-- Wake-on-LAN: the device's MAC address (entered, or learned over SSH) and an
-- optional broadcast address (default: the .255 of its /24).
ALTER TABLE devices
    ADD COLUMN mac           text NOT NULL DEFAULT '',
    ADD COLUMN wol_broadcast text NOT NULL DEFAULT '';
