ALTER TABLE `books` DROP COLUMN `monitor_for_upgrades`;--> statement-breakpoint
UPDATE `book_events` SET `event_type` = 'imported' WHERE `event_type` = 'upgraded';--> statement-breakpoint
UPDATE `notifiers`
SET `events` = (
  SELECT json_group_array(value)
  FROM json_each(`notifiers`.`events`)
  WHERE value != 'on_upgrade'
)
WHERE EXISTS (
  SELECT 1 FROM json_each(`notifiers`.`events`) WHERE value = 'on_upgrade'
);--> statement-breakpoint
UPDATE `notifiers`
SET `enabled` = 0
WHERE json_array_length(`events`) = 0;
