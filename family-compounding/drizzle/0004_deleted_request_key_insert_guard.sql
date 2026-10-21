CREATE TRIGGER family_activities_block_deleted_request_key
BEFORE INSERT ON family_activities
FOR EACH ROW
WHEN NEW.request_key IS NOT NULL AND EXISTS (
  SELECT 1 FROM family_request_keys
  WHERE request_key = NEW.request_key AND state = 'deleted'
)
BEGIN
  SELECT RAISE(ABORT, 'request key deleted');
END;
