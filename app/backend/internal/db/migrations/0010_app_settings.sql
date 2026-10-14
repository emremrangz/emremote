-- Server-wide settings an administrator changes in the web interface.
CREATE TABLE app_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
