-- Retention deletes the stored image and records that by nulling the pointer.
--
-- Before this, "storageKey" was NOT NULL, so there was no way to say "this
-- sheet was received and extracted, and its image has since been pruned" --
-- the only options were to keep every image forever or to delete the row and
-- lose the cost and throughput history that /api/stats is built from.
--
-- Widening a NOT NULL column to NULL rewrites no rows and takes only a brief
-- ACCESS EXCLUSIVE lock on the catalog entry, so this is safe to run online.
ALTER TABLE "sheets" ALTER COLUMN "storageKey" DROP NOT NULL;
