# Changelog

## [2.3.0](https://github.com/jxsuite/jx/compare/protocol-v2.2.0...protocol-v2.3.0) (2026-09-09)


### Features

* **studio,server,protocol:** one toggle installs an extension and enables it ([abe69bb](https://github.com/jxsuite/jx/commit/abe69bb60242ef97a49766040466d480ec3b93c9))
* **studio,server,protocol:** one toggle installs an extension and enables it ([f6d6b2c](https://github.com/jxsuite/jx/commit/f6d6b2cc88810401a57ca941c1bdef182137df6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 2.2.0

## [2.2.0](https://github.com/jxsuite/jx/compare/protocol-v2.1.0...protocol-v2.2.0) (2026-08-30)


### Features

* **studio:** a hosted backend can import a site into a repository ([2bcbeee](https://github.com/jxsuite/jx/commit/2bcbeee9fdaa5aa5d6b8a879bc3d8f510d451752))


### Bug Fixes

* **studio:** a lapsed Cloudflare grant no longer ends the connect flow before it starts ([83102d2](https://github.com/jxsuite/jx/commit/83102d2eaf64752895efe8118afacc605eaa2aff))
* **studio:** a lapsed Cloudflare grant no longer ends the connect flow before it starts ([4887415](https://github.com/jxsuite/jx/commit/4887415119c8640e269fc3a5cd878367d946706d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 2.1.0

## [2.1.0](https://github.com/jxsuite/jx/compare/protocol-v2.0.0...protocol-v2.1.0) (2026-08-27)


### Features

* **import:** limit the breakpoints an import keeps, and strip the classes it cannot use ([9ac5b60](https://github.com/jxsuite/jx/commit/9ac5b600a0b6834bb031daa64e1283ab51346cff))
* **import:** make jx-import --verify able to fail ([71382d5](https://github.com/jxsuite/jx/commit/71382d54e604aad01beba52d08ec99d826b13bee)), closes [#232](https://github.com/jxsuite/jx/issues/232)
* **import:** the site-import workflow, end to end ([eab1109](https://github.com/jxsuite/jx/commit/eab1109e0fc21a5f311d2f1c8f90626c1d51c55d))
* Open in Browser previews the working tree through the runtime ([b02e0e5](https://github.com/jxsuite/jx/commit/b02e0e543016879c963810f770b568995023e6ed))
* **server,studio:** the import stream says what the run found, and can check its own fidelity ([2e4c0e3](https://github.com/jxsuite/jx/commit/2e4c0e3dd1b63aead94bb70379c7ad8738420fd8))
* **studio:** a backend may satisfy Open in Browser by rendering, not only by building ([47ce1e6](https://github.com/jxsuite/jx/commit/47ce1e61715857aebce741fe85410a41828bb50c))
* **studio:** Open in Browser previews the canvas, and Build Site keeps the compiler ([9c45d21](https://github.com/jxsuite/jx/commit/9c45d219f2c55740ded4299fc4a75c3852878787))
* **studio:** set the import's fidelity minimum in the New Project dialog ([d338bdb](https://github.com/jxsuite/jx/commit/d338bdbc616f80426058a7c0eeeb49af7919dd69))
* **studio:** the site import is an agent turn — model, brief, live status, and a pause to ask ([775abee](https://github.com/jxsuite/jx/commit/775abeeb20a4f1a727072ea60191c32bea5d0d9f))


### Bug Fixes

* **screenshots:** stop the screenshot lane churning, and fix the three defects underneath it ([1eb0e45](https://github.com/jxsuite/jx/commit/1eb0e45c0a3a1ca14859f0cf0dc322a4619eff51))
* **server,desktop:** answer a directory listing in stable path order ([8e7f314](https://github.com/jxsuite/jx/commit/8e7f3147bc9c4f91093066a5568459dfe0dcb4a7))
* **server,studio:** findReferences answers about every reference, and the rename keeps its promise ([84e558f](https://github.com/jxsuite/jx/commit/84e558f67abe9524e2895f0e9045fb6ad14a0981))
* **studio:** the Packages table shows each dependency's own npm latest ([a90e170](https://github.com/jxsuite/jx/commit/a90e170392398c93926d94e092d7ec9ebe9b83e6))
* **studio:** the Packages table shows each dependency's own npm latest ([b019a26](https://github.com/jxsuite/jx/commit/b019a26848d06a92c9136f27a27edb2bea6e10dd))
* **studio:** the Packages table shows each dependency's own npm latest ([4fa433f](https://github.com/jxsuite/jx/commit/4fa433fba641973f2bfbeed99e16c4de96482b4a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 2.0.0

## [2.0.0](https://github.com/jxsuite/jx/compare/protocol-v1.2.1...protocol-v2.0.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **studio,desktop:** StudioPlatform's `saveSettings` is replaced by `patchSettings`, which takes a set/remove patch and answers with the resulting store. It stays optional, so an adapter that implements neither degrades to cache-only rather than throwing.

### Features

* **protocol:** type what an upload answers, and what a backend will accept ([8192345](https://github.com/jxsuite/jx/commit/819234555b3b37b5ce21d71005fc4f2cb05aae62))
* **studio:** declare assetSpace, and resolve media in the canvas realm ([196d259](https://github.com/jxsuite/jx/commit/196d2596b337e6298d2f0c15e984a5f29f7abe92))


### Bug Fixes

* **studio,desktop:** settings are patches, and a blank field never deletes ([76846af](https://github.com/jxsuite/jx/commit/76846afc28d81ff16e284fbe0b12d1f47cb604bc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.9.0

## [1.2.1](https://github.com/jxsuite/jx/compare/protocol-v1.2.0...protocol-v1.2.1) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.8.1

## [1.2.0](https://github.com/jxsuite/jx/compare/protocol-v1.1.2...protocol-v1.2.0) (2026-08-23)


### Features

* **studio:** Cloudflare is the lead AI recommendation, and can be reconnected ([#174](https://github.com/jxsuite/jx/issues/174)) ([aa13308](https://github.com/jxsuite/jx/commit/aa1330859b995e2c0b4a658cc04cf4525cb3ff79))

## [1.1.2](https://github.com/jxsuite/jx/compare/protocol-v1.1.1...protocol-v1.1.2) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.8.0

## [1.1.1](https://github.com/jxsuite/jx/compare/protocol-v1.1.0...protocol-v1.1.1) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.7.0

## [1.1.0](https://github.com/jxsuite/jx/compare/protocol-v1.0.0...protocol-v1.1.0) (2026-08-19)


### Features

* **collab:** negotiate the wire envelope on the handshake — jx.collab.v1 ([5db8ae8](https://github.com/jxsuite/jx/commit/5db8ae8b781a1b5aeffbdd8f27cdf4c08ebb4540))
* **protocol:** one failure shape — RFC 9457 problem details ([2ab94b1](https://github.com/jxsuite/jx/commit/2ab94b189e1c1265f90713e36b8cb8030f9afd40))
* **studio,server,desktop:** P4 wave A — the app can say what happened ([98a4a3a](https://github.com/jxsuite/jx/commit/98a4a3a1f895981ebc0b06483ef31953d8ebf7ef))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **server:** give the previewed site its own origin, so Open in Browser is the real site ([90eb4b4](https://github.com/jxsuite/jx/commit/90eb4b4b3eba897a1028fa5a4029ef0dcae61f88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.6.0

## [1.0.0](https://github.com/jxsuite/jx/compare/protocol-v0.6.1...protocol-v1.0.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **studio:** `StudioPlatform` implementations must declare `createDestination` and honor `createProject`'s `destination`. `POST /__studio/create-project` rejects a request without one, and returns an absolute `root` for projects created outside the server root.

### Features

* **studio:** require a user-chosen destination for new projects ([e08966c](https://github.com/jxsuite/jx/commit/e08966cc2d7a7ba34d4b12f3a6186396539b07da))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.5.0

## [0.6.1](https://github.com/jxsuite/jx/compare/protocol-v0.6.0...protocol-v0.6.1) (2026-07-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.4.0

## [0.6.0](https://github.com/jxsuite/jx/compare/protocol-v0.5.1...protocol-v0.6.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.3.0

## [0.5.1](https://github.com/jxsuite/jx/compare/protocol-v0.5.0...protocol-v0.5.1) (2026-07-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.2.0

## [0.5.0](https://github.com/jxsuite/jx/compare/protocol-v0.4.0...protocol-v0.5.0) (2026-07-17)


### Features

* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Bug Fixes

* **studio,compiler,parser,protocol,auth:** keep the promises the docs audit surfaced ([03ac07f](https://github.com/jxsuite/jx/commit/03ac07ff3a53c125587050a277b3dfa7b0ce86b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/schema bumped to 1.1.0

## [0.4.0](https://github.com/jxsuite/jx/compare/protocol-v0.3.1...protocol-v0.4.0) (2026-07-13)

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- **studio:** data console — connections, schema push, secrets, data grid ([ea92f95](https://github.com/jxsuite/jx/commit/ea92f955cdfce5774a0ae72f01038e00c8d310ae))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/schema bumped to 1.0.0

## [0.3.1](https://github.com/jxsuite/jx/compare/protocol-v0.3.0...protocol-v0.3.1) (2026-07-08)

### Bug Fixes

- **protocol:** clarify npm coordinates and dependency in README ([92abaa0](https://github.com/jxsuite/jx/commit/92abaa048a042126639c3393f27feadd4858a607))

## [0.3.0](https://github.com/jxsuite/jx/compare/protocol-v0.2.0...protocol-v0.3.0) (2026-07-08)

### Features

- **collab:** the wire — ws client/room core, devserver endpoint, adapter members ([d9f4b42](https://github.com/jxsuite/jx/commit/d9f4b425ac1d31cd3d7f9b2892e05321de08a09d))

## [0.2.0](https://github.com/jxsuite/jx/compare/protocol-v0.1.0...protocol-v0.2.0) (2026-07-07)

### Features

- **protocol:** @jxsuite/protocol — the Studio Backend Protocol package ([e859f36](https://github.com/jxsuite/jx/commit/e859f36eecead91de37ff6ec9ea51e7d3ca0691c))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/schema bumped to 0.35.0
