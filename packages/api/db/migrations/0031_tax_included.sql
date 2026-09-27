-- Tax-inclusive prices (ADR 0044): the item's marked price already contains its sales tax. The
-- register rings it at that price and the sale records the flag on the line, so the tax is backed
-- out of the price on every report. Items imported from NRS with "includes taxes" get it now.
ALTER TABLE items ADD COLUMN tax_included boolean NOT NULL DEFAULT false;

UPDATE items SET tax_included = true WHERE (attrs -> 'nrs' ->> 'price_includes_tax')::boolean IS TRUE;
