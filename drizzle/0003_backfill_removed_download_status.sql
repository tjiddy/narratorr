-- Map existing rows off the removed `processing_queued` download status.
UPDATE `downloads` SET `status` = 'completed' WHERE `status` = 'processing_queued';
