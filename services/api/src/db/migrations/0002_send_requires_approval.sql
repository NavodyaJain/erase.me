-- Defence in depth for the approval guard (PRD F6-AC1, F6-AC2, AGENTS rule 1).
--
-- The service layer is the primary enforcement point. This trigger makes the database refuse, too:
-- a request cannot leave `drafted` or `approved` (into sent, replied_*, no_reply or bounced) unless the
-- latest draft has an `approved` event that
--   - was recorded by a user (not the system or an admin),
--   - carries the same draft_hash as the latest draft, and
--   - is not older than that draft (so an edit, even one that reverts to earlier text, needs a fresh approval).
-- Moving to `drafted`, `approved` or `closed` is not guarded; those states send nothing.

CREATE FUNCTION "enforce_send_requires_approval"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  latest_hash text;
  latest_at timestamptz;
BEGIN
  IF NEW.status IN ('drafted', 'approved', 'closed') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status NOT IN ('drafted', 'approved') THEN
    RETURN NEW;
  END IF;

  SELECT d.draft_hash, d.created_at INTO latest_hash, latest_at
    FROM request_drafts d
   WHERE d.request_id = NEW.id
   ORDER BY d.version DESC
   LIMIT 1;

  IF latest_hash IS NULL OR NOT EXISTS (
    SELECT 1
      FROM request_events e
     WHERE e.request_id = NEW.id
       AND e.type = 'approved'
       AND e.actor_type = 'user'
       AND e.draft_hash = latest_hash
       AND e.created_at >= latest_at
  ) THEN
    RAISE EXCEPTION 'request % cannot be sent without a user approval of the current draft', NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'Record an approved event by a user with the current draft_hash first.';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "requests_send_requires_approval"
BEFORE INSERT OR UPDATE OF "status" ON "requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_send_requires_approval"();
