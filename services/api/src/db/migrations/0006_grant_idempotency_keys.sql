-- Claims are inserted, then completed or failed (UPDATE). The app role never deletes them.
GRANT SELECT, INSERT, UPDATE ON "idempotency_keys" TO erase_app;
