-- Screen recordings of remote sessions. The recording itself is a file on the recordings volume (written by the
-- gateway); this table says whose it is and what it shows. Rows outlive the user or device they came from.
CREATE TABLE recordings (
    id              uuid PRIMARY KEY,
    session_id      text NOT NULL,
    user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
    username        text NOT NULL,
    device_id       uuid REFERENCES devices (id) ON DELETE SET NULL,
    device_name     text NOT NULL,
    connection_name text NOT NULL,
    protocol        text NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    size_bytes      bigint NOT NULL DEFAULT 0
);
CREATE INDEX recordings_started_idx ON recordings (started_at DESC);
CREATE INDEX recordings_user_idx ON recordings (user_id, started_at DESC);
