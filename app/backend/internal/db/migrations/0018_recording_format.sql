-- SSH sessions in the built-in terminal are recorded as text (asciicast v2); the gateway's recordings stay "guac".
ALTER TABLE recordings ADD COLUMN format text NOT NULL DEFAULT 'guac' CHECK (format IN ('guac', 'cast'));
