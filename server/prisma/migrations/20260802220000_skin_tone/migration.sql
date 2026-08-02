-- Skin tone joins nationality and presents-as as a filterable, avatar-derived
-- attribute. The extractor now asks apimart for it per entry.
--
-- Both columns are nullable/absent for the rows that predate them, which reads
-- the same as "any": a Person with no skinTone is not excluded unless a rule
-- names specific tones, and existing filter_rules carry no tone constraint. A
-- scalar-list column left NULL is surfaced by Prisma as an empty array, exactly
-- as "countries" already behaves for rows created before it existed.
ALTER TABLE "people" ADD COLUMN "skinTone" TEXT;
ALTER TABLE "filter_rules" ADD COLUMN "skinTones" TEXT[];
