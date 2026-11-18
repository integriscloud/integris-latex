# Self-hosted fonts

Variable fonts from the official OFL sources (github.com/google/fonts, `ofl/`), subset with
fonttools to Latin + Latin Extended, combining diacritics (U+0300–036F, tone marks), IPA letters
used by West African languages (ɛ, ɔ, ŋ…), Latin Extended Additional, punctuation and currency
symbols, then compressed to woff2. Licences: `OFL-*.txt` (SIL Open Font License 1.1).

Unicode ranges: `U+0000-036F, U+1D00-1DBF, U+1E00-1EFF, U+2000-206F, U+20A0-20C0, U+2113, U+2122,
U+2191, U+2193, U+2212, U+2215, U+2C60-2C7F, U+A720-A7FF, U+FEFF, U+FFFD`.

| File                                              | Use                                                         |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `PlusJakartaSans.woff2`                           | UI (`--font-ui`)                                            |
| `SourceSerif4.woff2`, `SourceSerif4-Italic.woff2` | Titles and documents (`--font-doc`), not on the editor page |
| `JetBrainsMono.woff2`                             | Code, logs, SMS code boxes (`--font-code`), not preloaded   |
