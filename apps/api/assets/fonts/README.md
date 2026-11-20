# Fonts of the receipt PDFs

`PlusJakartaSans.ttf`: the variable font from the official OFL source (github.com/google/fonts,
`ofl/plusjakartasans`), the same as `apps/web/src/fonts/PlusJakartaSans.woff2` before subsetting.
PDFKit embeds its default instance (weight 400) and subsets it to the characters of each receipt.
The woff2 of the web app cannot be used: its transformed `glyf`/`loca` tables break the subsetting.
Licence: `OFL-PlusJakartaSans.txt` (SIL Open Font License 1.1).
