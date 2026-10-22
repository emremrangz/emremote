-- Where a device is, for the map on the Overview page. Optional; both coordinates are set or neither.
ALTER TABLE devices
    ADD COLUMN latitude  double precision,
    ADD COLUMN longitude double precision,
    ADD COLUMN location  text NOT NULL DEFAULT '',
    ADD CONSTRAINT devices_location_check CHECK (
        (latitude IS NULL AND longitude IS NULL)
        OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
    );
