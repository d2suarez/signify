-- Who may see a library set at all, by what Signify ID says the school
-- belongs to (its tenant_affiliations): 'NAD' = only NAD schools. Null =
-- every school (then 'open'/'school' distribution decides as before). Comes
-- from the seed's framework.audience; loadLibrary keeps loaded sets in step
-- with their seeds, so this is filled on the first library visit.
ALTER TABLE standard_frameworks ADD COLUMN audience text;
