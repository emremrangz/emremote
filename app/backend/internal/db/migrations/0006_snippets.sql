-- Personal command snippets. They are text the user types into their own
-- terminal sessions; nothing here is ever executed by the server.
CREATE TABLE snippets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    category     text NOT NULL DEFAULT '' CHECK (char_length(category) <= 32),
    use_count    integer NOT NULL DEFAULT 0,
    last_used_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX snippets_owner_name_key ON snippets (owner_id, lower(name));
CREATE INDEX snippets_owner_recent_idx ON snippets (owner_id, last_used_at DESC NULLS LAST);
