-- Where the file of a recording is: on this server only, on the network share only, or on both.
ALTER TABLE recordings
    ADD COLUMN location text NOT NULL DEFAULT 'local' CHECK (location IN ('local', 'remote', 'both'));
