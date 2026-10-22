# UI localization

Open Deck provides the same 19 language choices listed by the referenced Macro Deck
Companion documentation and resource catalogs: Arabic, Brazilian Portuguese, Czech,
Dutch, English, French, German, Hindi, Indonesian, Italian, Japanese, Korean, Polish,
Russian, Simplified Chinese, Spanish, Traditional Chinese, Turkish and Ukrainian.
`system` is a selection mode, not a twentieth language. Taiwan, Hong Kong, Macau and
Hant device locales select Traditional Chinese. Unsupported device languages select
English. Android 13 and later can also select an app language in Android settings.

The Mac editor, native Mac menus/dialog buttons and native Android product screens
load local, versioned catalogs. Product UI includes the editor, settings, pairing,
OS actions, monitoring, connection status and known API validation messages. Dates
and number formatting follow the chosen locale. Android OS calendar operations
retain the explicitly displayed Korean Standard Time scheduling policy.

User-authored deck/page/widget names, entered text, external calendar/task content,
provider data and imported archive reports are preserved. Technical logs and unknown
third-party/OS errors are shown in their original form. Arabic settings and forms
use right-to-left reading direction; physical deck coordinates are preserved.

## Coverage and translation provenance

`sources.json` inventories fixed product UI/known error strings from the current
sources. `scripts/i18n/merge-catalogs.py` is an offline merge and Android asset sync.
`node --test test/i18n.test.mjs` requires every inventoried key in every locale,
checks placeholders, rejects untranslated Korean prose in non-Korean catalogs,
checks exact Android/web catalog agreement, and checks that dynamic user data stays
unchanged when a product error template is localized.

The initial catalog used common Macro Deck Apache-2.0 translations and build-time
machine translations of already-public Open Deck UI strings. The allowed public
input was checked against published commit
`4b59a45a99864d3e8509f013a582336fa3c93d5b`; URLs, email addresses and business names
were excluded. `public-source-proof.json` records this provenance. No user data,
runtime deck contents or credentials were sent. New unpublished product strings
were translated directly in the checked-in `manual-*.json` overlays. Runtime apps
never contact a translation service.

This is complete key coverage, not a claim of professional human review in every
language. Placeholder integrity and selected live screens are verified separately;
terminology and line wrapping in languages not manually reviewed may need refinement.
The actual device evidence and language screenshots are recorded by the release
verification workflow, not inferred from the catalog tests.

Upstream translation license and attribution are included in
`docs/licenses/Macro-Deck-Apache-2.0.txt` and
`docs/licenses/Macro-Deck-Localization-NOTICE.txt`, and in both app packages.
