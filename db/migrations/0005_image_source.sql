-- 0005_image_source.sql
-- Tracks whether a product's image_url has been mirrored into R2 and from which source.
-- NULL  = never mirrored (original TCGPlayer CDN URL or no URL)
-- 'skrydex'   = mirrored from Skrydex CDN into R2
-- 'tcgplayer' = mirrored from TCGPlayer CDN into R2

ALTER TABLE tcg_products ADD COLUMN image_source TEXT;
