# Changelog

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
