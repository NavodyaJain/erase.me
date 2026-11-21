-- Sessions and OAuth state are mutable (revoke, consume) but never deleted by the app role.
-- Expired rows are purged by the owner-role purge job in Phase 2 (see docs/OPEN-QUESTIONS.md).
GRANT SELECT, INSERT, UPDATE ON "sessions", "oauth_states" TO erase_app;
