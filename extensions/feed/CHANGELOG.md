# Changelog

## [0.3.0](https://github.com/jxsuite/jx/compare/feed-v0.2.0...feed-v0.3.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **feed:** `contentMode: "none"` is no longer accepted. It never did anything: shared.ts branches on "full" alone, so `none` and `summary` produced byte-identical output in both serializers — Atom emits <summary> unconditionally, and JSON Feed always writes content_text because 1.1 requires one of content_html/content_text. A true `none` was never implementable there.

### Features

* **feed:** drop the inert contentMode "none" and correct the feeds page ([52b6d7a](https://github.com/jxsuite/jx/commit/52b6d7a56155e9d78b4ef8155f76b0b6e7c80d04))


### Bug Fixes

* defects surfaced by fact-checking the new package READMEs ([c4a614d](https://github.com/jxsuite/jx/commit/c4a614dae5e199d49384f998a0b937354f9de882))
* **feed:** name the project fragment $id to the shared ext/&lt;name&gt;/&lt;kind&gt;/v&lt;n&gt; shape ([1c16257](https://github.com/jxsuite/jx/commit/1c16257e669e81dbc264ebe8b5432dcb8a4e526a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.7.0

## [0.2.0](https://github.com/jxsuite/jx/compare/feed-v0.1.0...feed-v0.2.0) (2026-08-19)


### Features

* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a collection is localized end to end, and a starter proves it ([2230a01](https://github.com/jxsuite/jx/commit/2230a011b28743988725d061b7086cc02038cfb8))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))


### Bug Fixes

* **parser:** localized content never reached its own locale's asset mount ([179311b](https://github.com/jxsuite/jx/commit/179311b3f56d001eea37c092d73956c20056c55d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.6.0
