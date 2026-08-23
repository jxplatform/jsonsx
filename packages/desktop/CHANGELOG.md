# Changelog

## [2.3.0](https://github.com/jxsuite/jx/compare/desktop-v2.2.2...desktop-v2.3.0) (2026-08-23)


### Features

* **studio:** the package states its own layout, and hosts itself ([17ed4bc](https://github.com/jxsuite/jx/commit/17ed4bcfce451a21adb5729054a4934f2ef032f4))


### Bug Fixes

* **desktop:** a bare jx-studio watched the whole home directory ([b9d78d7](https://github.com/jxsuite/jx/commit/b9d78d74484c54ec6b983ab81bb19364d3a4a779))
* **desktop:** a bare jx-studio watched the whole home directory ([f60059b](https://github.com/jxsuite/jx/commit/f60059b86ba92341fe62f8280c24ae250fc891bc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/server bumped to 2.2.3
    * @jxsuite/studio bumped to 2.3.0
  * devDependencies
    * @jxsuite/server bumped to 2.2.3

## [2.2.2](https://github.com/jxsuite/jx/compare/desktop-v2.2.1...desktop-v2.2.2) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.3
    * @jxsuite/create bumped to 1.3.3
    * @jxsuite/server bumped to 2.2.2
    * @jxsuite/starters bumped to 1.6.0
    * @jxsuite/studio bumped to 2.2.2
  * devDependencies
    * @jxsuite/server bumped to 2.2.2

## [2.2.1](https://github.com/jxsuite/jx/compare/desktop-v2.2.0...desktop-v2.2.1) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.2
    * @jxsuite/create bumped to 1.3.2
    * @jxsuite/parser bumped to 1.5.2
    * @jxsuite/protocol bumped to 1.1.2
    * @jxsuite/schema bumped to 1.8.0
    * @jxsuite/server bumped to 2.2.1
    * @jxsuite/starters bumped to 1.5.0
    * @jxsuite/studio bumped to 2.2.1
  * devDependencies
    * @jxsuite/connector bumped to 0.5.2
    * @jxsuite/server bumped to 2.2.1

## [2.2.0](https://github.com/jxsuite/jx/compare/desktop-v2.1.0...desktop-v2.2.0) (2026-08-21)


### Features

* **desktop:** bring the chromium launcher to PAL parity with electrobun ([9a94240](https://github.com/jxsuite/jx/commit/9a9424048403e48faf333e3ce788502ede4d2ce9))
* **desktop:** bring the chromium launcher to PAL parity with electrobun ([9846e1d](https://github.com/jxsuite/jx/commit/9846e1dcf8d94bb68082fa79f40d38c139689a91))


### Bug Fixes

* **desktop:** give the chromium window an identity the taskbar can resolve ([e816dfa](https://github.com/jxsuite/jx/commit/e816dfabb9de69b0a56d03cfa3f254e6841111f8))
* **desktop:** type two test mocks to the contracts they stand in for ([bc82556](https://github.com/jxsuite/jx/commit/bc82556185720f76c3fa45383db066cbd2f56001))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.1
    * @jxsuite/create bumped to 1.3.1
    * @jxsuite/parser bumped to 1.5.1
    * @jxsuite/protocol bumped to 1.1.1
    * @jxsuite/schema bumped to 1.7.0
    * @jxsuite/server bumped to 2.2.0
    * @jxsuite/starters bumped to 1.4.0
    * @jxsuite/studio bumped to 2.2.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.1
    * @jxsuite/server bumped to 2.2.0

## [2.1.0](https://github.com/jxsuite/jx/compare/desktop-v2.0.1...desktop-v2.1.0) (2026-08-19)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **server:** read Fetch Metadata, and close the three ungated project-server routes ([18bd5da](https://github.com/jxsuite/jx/commit/18bd5dab144d76c5c97b08fb43c28fb3e5ad127b))
* **studio,desktop:** P0 wave A — enforcement rails and three dead RPCs ([e078d46](https://github.com/jxsuite/jx/commit/e078d4668cb8ee453852ffe0acd5f1cd561de291))
* **studio,server,desktop:** P4 wave A — the app can say what happened ([98a4a3a](https://github.com/jxsuite/jx/commit/98a4a3a1f895981ebc0b06483ef31953d8ebf7ef))
* **studio:** say it out loud — one live region, and the affordances high contrast deletes ([d414bcd](https://github.com/jxsuite/jx/commit/d414bcdda6d01749eda43e1900edf0d2eb6656c7))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **desktop:** the Nix bundle deleted the extension packages it depends on ([cf3df55](https://github.com/jxsuite/jx/commit/cf3df5583ee50c1f18acd3d767c386e5ba63bd21))
* **parser:** localized content never reached its own locale's asset mount ([179311b](https://github.com/jxsuite/jx/commit/179311b3f56d001eea37c092d73956c20056c55d))
* **server:** give the previewed site its own origin, so Open in Browser is the real site ([90eb4b4](https://github.com/jxsuite/jx/commit/90eb4b4b3eba897a1028fa5a4029ef0dcae61f88))
* **studio:** Open Project's "New Window" opened in this window ([e233bf1](https://github.com/jxsuite/jx/commit/e233bf13214fce1ec018a4bd91ec7d235edb1056))
* **studio:** Open Project's "New Window" opened in this window ([2879f4e](https://github.com/jxsuite/jx/commit/2879f4e2034fc89ce39451660313c3418469e96d))
* **types:** repair the two typecheck errors the workspace tsconfigs see ([373dfe1](https://github.com/jxsuite/jx/commit/373dfe13fba28ec44cd42edd8c862f6124805986))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.0
    * @jxsuite/create bumped to 1.3.0
    * @jxsuite/parser bumped to 1.5.0
    * @jxsuite/protocol bumped to 1.1.0
    * @jxsuite/schema bumped to 1.6.0
    * @jxsuite/server bumped to 2.1.0
    * @jxsuite/starters bumped to 1.3.0
    * @jxsuite/studio bumped to 2.1.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.0
    * @jxsuite/server bumped to 2.1.0

## [2.0.1](https://github.com/jxsuite/jx/compare/desktop-v2.0.0...desktop-v2.0.1) (2026-07-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/studio bumped to 2.0.1

## [2.0.0](https://github.com/jxsuite/jx/compare/desktop-v1.2.1...desktop-v2.0.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **studio:** `StudioPlatform` implementations must declare `createDestination` and honor `createProject`'s `destination`. `POST /__studio/create-project` rejects a request without one, and returns an absolute `root` for projects created outside the server root.

### Features

* **studio:** require a user-chosen destination for new projects ([e08966c](https://github.com/jxsuite/jx/commit/e08966cc2d7a7ba34d4b12f3a6186396539b07da))
* **studio:** upload and drop media from every editing surface ([ed5999b](https://github.com/jxsuite/jx/commit/ed5999b8522bcae408ac19c60d4758c40c7ff688))


### Bug Fixes

* **desktop,studio,server,collab:** typecheck the desktop package, and hold the coverage gates ([4a348b1](https://github.com/jxsuite/jx/commit/4a348b131be242ac14fe8097bb5cb431a9c64155))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **studio,server,desktop:** dev server bypassed the build; Monaco still loaded at startup ([288fb73](https://github.com/jxsuite/jx/commit/288fb73a0aae78318f17a4d1a24a73e0a523104e))
* **studio:** resolve project schemas offline and ship Monaco's workers everywhere ([bf04699](https://github.com/jxsuite/jx/commit/bf04699944b48e0523dc22890ebcbbbea25f0310))


### Performance Improvements

* **studio:** code-split the bundle and load Monaco on demand ([78d85ba](https://github.com/jxsuite/jx/commit/78d85ba20569ff63ad279371923218f1ab7cc7b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 1.5.0
    * @jxsuite/create bumped to 1.2.2
    * @jxsuite/parser bumped to 1.4.1
    * @jxsuite/protocol bumped to 1.0.0
    * @jxsuite/schema bumped to 1.5.0
    * @jxsuite/server bumped to 2.0.0
    * @jxsuite/starters bumped to 1.2.2
    * @jxsuite/studio bumped to 2.0.0
  * devDependencies
    * @jxsuite/connector bumped to 0.4.2
    * @jxsuite/server bumped to 2.0.0

## [1.2.1](https://github.com/jxsuite/jx/compare/desktop-v1.2.0...desktop-v1.2.1) (2026-07-24)


### Bug Fixes

* **desktop:** stage create/starters static data into the Electrobun bundle ([8b8d56a](https://github.com/jxsuite/jx/commit/8b8d56ae1de4c52200861d5b6cc474d634bc5d84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 1.4.0
    * @jxsuite/create bumped to 1.2.1
    * @jxsuite/parser bumped to 1.4.0
    * @jxsuite/protocol bumped to 0.6.1
    * @jxsuite/schema bumped to 1.4.0
    * @jxsuite/server bumped to 1.3.0
    * @jxsuite/starters bumped to 1.2.1
    * @jxsuite/studio bumped to 1.5.0
  * devDependencies
    * @jxsuite/connector bumped to 0.4.1
    * @jxsuite/server bumped to 1.3.0

## [1.2.0](https://github.com/jxsuite/jx/compare/desktop-v1.1.2...desktop-v1.2.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* **starters,examples:** repair documents the schema correctly rejected ([6913028](https://github.com/jxsuite/jx/commit/691302839526b4f1408ab98ca1b418b39784b01b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 1.3.0
    * @jxsuite/create bumped to 1.2.0
    * @jxsuite/parser bumped to 1.3.0
    * @jxsuite/protocol bumped to 0.6.0
    * @jxsuite/schema bumped to 1.3.0
    * @jxsuite/server bumped to 1.2.0
    * @jxsuite/starters bumped to 1.2.0
    * @jxsuite/studio bumped to 1.4.0
  * devDependencies
    * @jxsuite/connector bumped to 0.4.0
    * @jxsuite/server bumped to 1.2.0

## [1.1.2](https://github.com/jxsuite/jx/compare/desktop-v1.1.1...desktop-v1.1.2) (2026-07-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/studio bumped to 1.3.0

## [1.1.1](https://github.com/jxsuite/jx/compare/desktop-v1.1.0...desktop-v1.1.1) (2026-07-18)


### Bug Fixes

* enable notarization in electrobun configuration ([cbd613d](https://github.com/jxsuite/jx/commit/cbd613dc350abbd282bb9e8c87ec7b1430d1091e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 1.2.0
    * @jxsuite/create bumped to 1.1.1
    * @jxsuite/parser bumped to 1.2.0
    * @jxsuite/protocol bumped to 0.5.1
    * @jxsuite/schema bumped to 1.2.0
    * @jxsuite/server bumped to 1.1.1
    * @jxsuite/starters bumped to 1.1.1
    * @jxsuite/studio bumped to 1.2.0
  * devDependencies
    * @jxsuite/connector bumped to 0.3.1
    * @jxsuite/server bumped to 1.1.1

## [1.1.0](https://github.com/jxsuite/jx/compare/desktop-v1.0.0...desktop-v1.1.0) (2026-07-17)


### Features

* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 1.1.0
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/parser bumped to 1.1.0
    * @jxsuite/protocol bumped to 0.5.0
    * @jxsuite/schema bumped to 1.1.0
    * @jxsuite/server bumped to 1.1.0
    * @jxsuite/starters bumped to 1.1.0
    * @jxsuite/studio bumped to 1.1.0
  * devDependencies
    * @jxsuite/connector bumped to 0.3.0
    * @jxsuite/server bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/desktop-v0.35.3...desktop-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **studio:** data console — connections, schema push, secrets, data grid ([ea92f95](https://github.com/jxsuite/jx/commit/ea92f955cdfce5774a0ae72f01038e00c8d310ae))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 1.0.0
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/parser bumped to 1.0.0
    - @jxsuite/protocol bumped to 0.4.0
    - @jxsuite/schema bumped to 1.0.0
    - @jxsuite/server bumped to 1.0.0
    - @jxsuite/starters bumped to 1.0.0
    - @jxsuite/studio bumped to 1.0.0
  - devDependencies
    - @jxsuite/connector bumped to 0.2.0
    - @jxsuite/server bumped to 1.0.0

## [0.35.3](https://github.com/jxsuite/jx/compare/desktop-v0.35.2...desktop-v0.35.3) (2026-07-08)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/server bumped to 0.37.1
    - @jxsuite/studio bumped to 0.37.1
  - devDependencies
    - @jxsuite/server bumped to 0.37.1

## [0.35.2](https://github.com/jxsuite/jx/compare/desktop-v0.35.1...desktop-v0.35.2) (2026-07-08)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/server bumped to 0.37.0
    - @jxsuite/studio bumped to 0.37.0
  - devDependencies
    - @jxsuite/server bumped to 0.37.0

## [0.35.1](https://github.com/jxsuite/jx/compare/desktop-v0.35.0...desktop-v0.35.1) (2026-07-07)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 0.35.0
    - @jxsuite/create bumped to 0.36.0
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/schema bumped to 0.35.0
    - @jxsuite/server bumped to 0.36.0
    - @jxsuite/starters bumped to 0.35.1
    - @jxsuite/studio bumped to 0.36.0
  - devDependencies
    - @jxsuite/server bumped to 0.36.0

## [0.35.0](https://github.com/jxsuite/jx/compare/desktop-v0.34.0...desktop-v0.35.0) (2026-07-06)

### Features

- **desktop:** persistent cross-platform user settings ([352cf36](https://github.com/jxsuite/jx/commit/352cf3636d7d1a132d847db1b15703c6be9fa30a))
- **desktop:** wire up the "new project" feature ([5f9fec3](https://github.com/jxsuite/jx/commit/5f9fec325269ebada329f383825f096db657610f))
- site import package, ui + starter templates & wizard ([9c44e4a](https://github.com/jxsuite/jx/commit/9c44e4abe7e9d75c1129c179a419f5a390f86da9))
- **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))

### Bug Fixes

- **desktop:** correct class on chromium runtime ([129a991](https://github.com/jxsuite/jx/commit/129a991babc316ae3b719a13f99f12cd028b14a8))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 0.34.1
    - @jxsuite/create bumped to 0.35.0
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/server bumped to 0.35.0
    - @jxsuite/starters bumped to 0.35.0
    - @jxsuite/studio bumped to 0.35.0
  - devDependencies
    - @jxsuite/server bumped to 0.35.0
