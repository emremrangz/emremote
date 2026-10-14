-- RDP connections that still use the original default keyboard layout now
-- follow the layout detected in the user's browser. Explicit choices are kept.
UPDATE connections
SET settings = jsonb_set(settings, '{server_layout}', '"auto"'), updated_at = now()
WHERE protocol = 'rdp' AND settings->>'server_layout' = 'en-us-qwerty';
