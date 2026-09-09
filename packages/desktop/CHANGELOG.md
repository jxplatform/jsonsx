# Changelog

## [5.1.0](https://github.com/jxsuite/jx/compare/desktop-v5.0.1...desktop-v5.1.0) (2026-09-09)


### Features

* **studio,server,protocol:** one toggle installs an extension and enables it ([abe69bb](https://github.com/jxsuite/jx/commit/abe69bb60242ef97a49766040466d480ec3b93c9))
* **studio,server,protocol:** one toggle installs an extension and enables it ([f6d6b2c](https://github.com/jxsuite/jx/commit/f6d6b2cc88810401a57ca941c1bdef182137df6e))
* **studio:** highlight what changed in a diff, and open every changed file ([a54fa6d](https://github.com/jxsuite/jx/commit/a54fa6dc15fbe4ad7e8617d4e788c1670292ea2b))


### Bug Fixes

* **desktop,server:** the coverage gates the new catalogue member missed ([18eccd9](https://github.com/jxsuite/jx/commit/18eccd9af978bb7ed3a627939c14cb7e72e2f759))
* **studio,server:** the diff view drew line numbers and no text ([76d8d97](https://github.com/jxsuite/jx/commit/76d8d97f600622d2e381f3e1b2e37e88b0c40663))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 4.0.0
    * @jxsuite/create bumped to 1.3.10
    * @jxsuite/parser bumped to 1.8.0
    * @jxsuite/protocol bumped to 2.3.0
    * @jxsuite/schema bumped to 2.2.0
    * @jxsuite/server bumped to 4.2.0
    * @jxsuite/starters bumped to 1.7.1
    * @jxsuite/studio bumped to 5.0.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.8
    * @jxsuite/server bumped to 4.2.0

## [5.0.1](https://github.com/jxsuite/jx/compare/desktop-v5.0.0...desktop-v5.0.1) (2026-08-30)


### Bug Fixes

* **desktop:** exclude vendor from the Nix source so the published path is the one consumers ask for ([81d60bc](https://github.com/jxsuite/jx/commit/81d60bca5ea8e67b99a1e789a7c1881f9b2e018a))
* **desktop:** exclude vendor from the Nix source so the published path is the one consumers ask for ([65debec](https://github.com/jxsuite/jx/commit/65debec14fef2a13f775a36fe5f5529d8504c923)), closes [#250](https://github.com/jxsuite/jx/issues/250)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 3.1.0
    * @jxsuite/create bumped to 1.3.9
    * @jxsuite/parser bumped to 1.7.0
    * @jxsuite/protocol bumped to 2.2.0
    * @jxsuite/schema bumped to 2.1.0
    * @jxsuite/server bumped to 4.1.0
    * @jxsuite/starters bumped to 1.7.0
    * @jxsuite/studio bumped to 4.1.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.7
    * @jxsuite/server bumped to 4.1.0

## [5.0.0](https://github.com/jxsuite/jx/compare/desktop-v4.0.0...desktop-v5.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* **schema,site:** `@jxsuite/schema` no longer exports `./routes`, `./layout`, `./context` or `./head-merger`. Import them from `@jxsuite/site`; the modules and their behaviour are unchanged.

### Features

* **desktop:** both launchers can preview the working tree live ([5a7b816](https://github.com/jxsuite/jx/commit/5a7b8161252770d2f694bdd8c94e144c91f692cf))
* **import:** the site-import workflow, end to end ([eab1109](https://github.com/jxsuite/jx/commit/eab1109e0fc21a5f311d2f1c8f90626c1d51c55d))
* Open in Browser previews the working tree through the runtime ([b02e0e5](https://github.com/jxsuite/jx/commit/b02e0e543016879c963810f770b568995023e6ed))
* **studio:** watch an import in the project, in a feed that outlives the run ([509a1fd](https://github.com/jxsuite/jx/commit/509a1fdb313b26971bfffbd97a600f67999509e7))


### Bug Fixes

* **desktop,import:** the two gates the live preview left red, and the coverage it owed ([72657b7](https://github.com/jxsuite/jx/commit/72657b7c636d63aecb831378e5f16e134b062adb))
* **screenshots:** stop the screenshot lane churning, and fix the three defects underneath it ([1eb0e45](https://github.com/jxsuite/jx/commit/1eb0e45c0a3a1ca14859f0cf0dc322a4619eff51))
* **server,desktop:** answer a directory listing in stable path order ([8e7f314](https://github.com/jxsuite/jx/commit/8e7f3147bc9c4f91093066a5568459dfe0dcb4a7))
* **server,studio:** findReferences answers about every reference, and the rename keeps its promise ([84e558f](https://github.com/jxsuite/jx/commit/84e558f67abe9524e2895f0e9045fb6ad14a0981))
* **server:** resolve rooted refs through every lane, and index refs by shape ([29d3271](https://github.com/jxsuite/jx/commit/29d32716fb3c35e2e37235d4091739d950c2693a)), closes [#239](https://github.com/jxsuite/jx/issues/239)
* **studio:** the Packages table shows each dependency's own npm latest ([a90e170](https://github.com/jxsuite/jx/commit/a90e170392398c93926d94e092d7ec9ebe9b83e6))
* **studio:** the Packages table shows each dependency's own npm latest ([b019a26](https://github.com/jxsuite/jx/commit/b019a26848d06a92c9136f27a27edb2bea6e10dd))
* **studio:** the Packages table shows each dependency's own npm latest ([4fa433f](https://github.com/jxsuite/jx/commit/4fa433fba641973f2bfbeed99e16c4de96482b4a))


### Code Refactoring

* **schema,site:** site composition gets its own package ([f9d270d](https://github.com/jxsuite/jx/commit/f9d270daf261eef9ac9566192787b7a4bba25135))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 3.0.0
    * @jxsuite/create bumped to 1.3.8
    * @jxsuite/parser bumped to 1.6.0
    * @jxsuite/protocol bumped to 2.1.0
    * @jxsuite/schema bumped to 2.0.0
    * @jxsuite/server bumped to 4.0.0
    * @jxsuite/starters bumped to 1.6.5
    * @jxsuite/studio bumped to 4.0.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.6
    * @jxsuite/server bumped to 4.0.0

## [4.0.0](https://github.com/jxsuite/jx/compare/desktop-v3.0.1...desktop-v4.0.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **studio,desktop:** StudioPlatform's `saveSettings` is replaced by `patchSettings`, which takes a set/remove patch and answers with the resulting store. It stays optional, so an adapter that implements neither degrades to cache-only rather than throwing.

### Features

* **protocol:** type what an upload answers, and what a backend will accept ([8192345](https://github.com/jxsuite/jx/commit/819234555b3b37b5ce21d71005fc4f2cb05aae62))
* **studio:** declare assetSpace, and resolve media in the canvas realm ([196d259](https://github.com/jxsuite/jx/commit/196d2596b337e6298d2f0c15e984a5f29f7abe92))
* **studio:** declare assetSpace, and resolve media in the canvas realm ([92b087f](https://github.com/jxsuite/jx/commit/92b087f2e504896f7f9800df18ff1310c40e8c4c))


### Bug Fixes

* **desktop:** type the settings patch the window-manager test mocks ([f268344](https://github.com/jxsuite/jx/commit/f268344b15b0b57dd04b0115bd86b7a7f6abb50d))
* **studio,desktop:** settings are patches, and a blank field never deletes ([76846af](https://github.com/jxsuite/jx/commit/76846afc28d81ff16e284fbe0b12d1f47cb604bc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.8
    * @jxsuite/create bumped to 1.3.7
    * @jxsuite/parser bumped to 1.5.6
    * @jxsuite/protocol bumped to 2.0.0
    * @jxsuite/schema bumped to 1.9.0
    * @jxsuite/server bumped to 3.0.0
    * @jxsuite/starters bumped to 1.6.4
    * @jxsuite/studio bumped to 3.0.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.5
    * @jxsuite/server bumped to 3.0.0

## [3.0.1](https://github.com/jxsuite/jx/compare/desktop-v3.0.0...desktop-v3.0.1) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.7
    * @jxsuite/create bumped to 1.3.6
    * @jxsuite/parser bumped to 1.5.5
    * @jxsuite/protocol bumped to 1.2.1
    * @jxsuite/schema bumped to 1.8.1
    * @jxsuite/server bumped to 2.2.7
    * @jxsuite/starters bumped to 1.6.3
    * @jxsuite/studio bumped to 2.4.3
  * devDependencies
    * @jxsuite/connector bumped to 0.5.4
    * @jxsuite/server bumped to 2.2.7

## [3.0.0](https://github.com/jxsuite/jx/compare/desktop-v2.3.3...desktop-v3.0.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **desktop:** move to Electrobun 2.0.1 stable and the npm-managed toolchain

### Features

* **desktop:** move to Electrobun 2.0.1 stable and the npm-managed toolchain ([2c8a202](https://github.com/jxsuite/jx/commit/2c8a2022dddc1f80854dc16bce09c18ee7e5a734))


### Bug Fixes

* **tests:** make the Windows suites runnable ([1c23891](https://github.com/jxsuite/jx/commit/1c23891ec56dce22e1e900ae151a49cb1ecdbe25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.6
    * @jxsuite/server bumped to 2.2.6
    * @jxsuite/studio bumped to 2.4.2
  * devDependencies
    * @jxsuite/connector bumped to 0.5.3
    * @jxsuite/server bumped to 2.2.6

## [2.3.3](https://github.com/jxsuite/jx/compare/desktop-v2.3.2...desktop-v2.3.3) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.5
    * @jxsuite/create bumped to 1.3.5
    * @jxsuite/parser bumped to 1.5.4
    * @jxsuite/server bumped to 2.2.5
    * @jxsuite/starters bumped to 1.6.2
    * @jxsuite/studio bumped to 2.4.1
  * devDependencies
    * @jxsuite/server bumped to 2.2.5

## [2.3.2](https://github.com/jxsuite/jx/compare/desktop-v2.3.1...desktop-v2.3.2) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.4
    * @jxsuite/create bumped to 1.3.4
    * @jxsuite/parser bumped to 1.5.3
    * @jxsuite/protocol bumped to 1.2.0
    * @jxsuite/server bumped to 2.2.4
    * @jxsuite/starters bumped to 1.6.1
    * @jxsuite/studio bumped to 2.4.0
  * devDependencies
    * @jxsuite/server bumped to 2.2.4

## [2.3.1](https://github.com/jxsuite/jx/compare/desktop-v2.3.0...desktop-v2.3.1) (2026-08-23)


### Bug Fixes

* **desktop:** the electrobun config is one the CLI can actually load ([#170](https://github.com/jxsuite/jx/issues/170)) ([f04baa8](https://github.com/jxsuite/jx/commit/f04baa87d245c1b1879c8213318372b86e1d04dd))

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
