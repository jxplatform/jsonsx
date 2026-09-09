# Changelog

## [4.2.0](https://github.com/jxsuite/jx/compare/server-v4.1.0...server-v4.2.0) (2026-09-09)


### Features

* **studio,server,protocol:** one toggle installs an extension and enables it ([abe69bb](https://github.com/jxsuite/jx/commit/abe69bb60242ef97a49766040466d480ec3b93c9))
* **studio,server,protocol:** one toggle installs an extension and enables it ([f6d6b2c](https://github.com/jxsuite/jx/commit/f6d6b2cc88810401a57ca941c1bdef182137df6e))
* **studio:** highlight what changed in a diff, and open every changed file ([a54fa6d](https://github.com/jxsuite/jx/commit/a54fa6dc15fbe4ad7e8617d4e788c1670292ea2b))


### Bug Fixes

* **ai:** stop sending an empty assistant turn, and replay a model's reasoning ([9b0d735](https://github.com/jxsuite/jx/commit/9b0d7353897444825087cace1b4489bc6965e9fb))
* **ai:** stop sending an empty assistant turn, and replay a model's reasoning ([d0b7fe1](https://github.com/jxsuite/jx/commit/d0b7fe19e0b40660f4ecb69e585df2682b05a129))
* **desktop,server:** the coverage gates the new catalogue member missed ([18eccd9](https://github.com/jxsuite/jx/commit/18eccd9af978bb7ed3a627939c14cb7e72e2f759))
* **server:** point catalog imports at extension-catalog.ts, not the renamed package ([8b171f4](https://github.com/jxsuite/jx/commit/8b171f400f9c8638c320341efeec8f1a06268a27))
* **server:** point package.json's ./catalog export at extension-catalog.ts ([97cdbd6](https://github.com/jxsuite/jx/commit/97cdbd690cba274b260c18b7ea52a09591798a3a))
* **studio,server:** the diff view drew line numbers and no text ([76d8d97](https://github.com/jxsuite/jx/commit/76d8d97f600622d2e381f3e1b2e37e88b0c40663))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.9.0
    * @jxsuite/compiler bumped to 4.0.0
    * @jxsuite/create bumped to 1.3.10
    * @jxsuite/import bumped to 0.40.2
    * @jxsuite/protocol bumped to 2.3.0
    * @jxsuite/runtime bumped to 4.0.0
    * @jxsuite/schema bumped to 2.2.0
    * @jxsuite/site bumped to 2.0.0
    * @jxsuite/starters bumped to 1.7.1
  * devDependencies
    * @jxsuite/auth bumped to 0.5.8
    * @jxsuite/connector bumped to 0.5.8
    * @jxsuite/parser bumped to 1.8.0

## [4.1.0](https://github.com/jxsuite/jx/compare/server-v4.0.0...server-v4.1.0) (2026-08-30)


### Features

* **compiler,server:** a site deployed under a subpath resolves its URLs against url's path ([c4b7f27](https://github.com/jxsuite/jx/commit/c4b7f27c82a19bfa1f62eff8a75597c13a3f90be))
* **compiler,server:** a site deployed under a subpath resolves its URLs against url's path ([988abd8](https://github.com/jxsuite/jx/commit/988abd8d3614f0ba3ce6cd8b1c1db589fef0a511)), closes [#235](https://github.com/jxsuite/jx/issues/235)
* **parser,schema,server:** a format may declare rewrite, repairing a reference a CSV row names ([bca762e](https://github.com/jxsuite/jx/commit/bca762eea4a3a1cd55de02892b7db322155fb1ec))
* **parser,schema,server:** a format may declare rewrite, repairing a reference a CSV row names ([29a0f36](https://github.com/jxsuite/jx/commit/29a0f36a43319e294e2e69b14c694ff9796bdc5c)), closes [#246](https://github.com/jxsuite/jx/issues/246)


### Bug Fixes

* **server:** a copy map's keys and a directory content source are references the engine can see ([9974204](https://github.com/jxsuite/jx/commit/997420475d738bc134f21108b5e8d193ae065314))
* **server:** a copy map's keys and a directory content source are references the engine can see ([5221a26](https://github.com/jxsuite/jx/commit/5221a26123622abdfcea5fc0e6e0fd37a57f7a93)), closes [#242](https://github.com/jxsuite/jx/issues/242) [#243](https://github.com/jxsuite/jx/issues/243)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.8.5
    * @jxsuite/compiler bumped to 3.1.0
    * @jxsuite/create bumped to 1.3.9
    * @jxsuite/import bumped to 0.40.1
    * @jxsuite/protocol bumped to 2.2.0
    * @jxsuite/runtime bumped to 3.1.0
    * @jxsuite/schema bumped to 2.1.0
    * @jxsuite/site bumped to 1.1.0
    * @jxsuite/starters bumped to 1.7.0
  * devDependencies
    * @jxsuite/auth bumped to 0.5.7
    * @jxsuite/connector bumped to 0.5.7
    * @jxsuite/parser bumped to 1.7.0

## [4.0.0](https://github.com/jxsuite/jx/compare/server-v3.0.0...server-v4.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* **schema,site:** `@jxsuite/schema` no longer exports `./routes`, `./layout`, `./context` or `./head-merger`. Import them from `@jxsuite/site`; the modules and their behaviour are unchanged.

### Features

* **import:** limit the breakpoints an import keeps, and strip the classes it cannot use ([9ac5b60](https://github.com/jxsuite/jx/commit/9ac5b600a0b6834bb031daa64e1283ab51346cff))
* **import:** the site-import workflow, end to end ([eab1109](https://github.com/jxsuite/jx/commit/eab1109e0fc21a5f311d2f1c8f90626c1d51c55d))
* Open in Browser previews the working tree through the runtime ([b02e0e5](https://github.com/jxsuite/jx/commit/b02e0e543016879c963810f770b568995023e6ed))
* **server,studio:** the import stream says what the run found, and can check its own fidelity ([2e4c0e3](https://github.com/jxsuite/jx/commit/2e4c0e3dd1b63aead94bb70379c7ad8738420fd8))
* **server:** the working tree, browsable at real routes, on its own origin ([eaaafe3](https://github.com/jxsuite/jx/commit/eaaafe319b12a251b7da1e6b2375a1aa0d56bea2))
* **studio:** choose a format on New File, convert between formats, and inherit a collection's ([1c1061b](https://github.com/jxsuite/jx/commit/1c1061b95a66cc5e73aaf73d3605c0e7a285e086))
* **studio:** Open in Browser previews the canvas, and Build Site keeps the compiler ([9c45d21](https://github.com/jxsuite/jx/commit/9c45d219f2c55740ded4299fc4a75c3852878787))
* **studio:** set the import's fidelity minimum in the New Project dialog ([d338bdb](https://github.com/jxsuite/jx/commit/d338bdbc616f80426058a7c0eeeb49af7919dd69))
* **studio:** the site import is an agent turn — model, brief, live status, and a pause to ask ([775abee](https://github.com/jxsuite/jx/commit/775abeeb20a4f1a727072ea60191c32bea5d0d9f))
* **studio:** watch an import in the project, in a feed that outlives the run ([509a1fd](https://github.com/jxsuite/jx/commit/509a1fdb313b26971bfffbd97a600f67999509e7))


### Bug Fixes

* **desktop,import:** the two gates the live preview left red, and the coverage it owed ([72657b7](https://github.com/jxsuite/jx/commit/72657b7c636d63aecb831378e5f16e134b062adb))
* **screenshots:** stop the screenshot lane churning, and fix the three defects underneath it ([1eb0e45](https://github.com/jxsuite/jx/commit/1eb0e45c0a3a1ca14859f0cf0dc322a4619eff51))
* **server,desktop:** answer a directory listing in stable path order ([8e7f314](https://github.com/jxsuite/jx/commit/8e7f3147bc9c4f91093066a5568459dfe0dcb4a7))
* **server,studio:** findReferences answers about every reference, and the rename keeps its promise ([84e558f](https://github.com/jxsuite/jx/commit/84e558f67abe9524e2895f0e9045fb6ad14a0981))
* **server:** a rename drops the co-editing room keyed to the old path ([e1e6f25](https://github.com/jxsuite/jx/commit/e1e6f25fdd31345cad69d83bef3a0454ae7dad8b))
* **server:** resolve rooted refs through every lane, and index refs by shape ([29d3271](https://github.com/jxsuite/jx/commit/29d32716fb3c35e2e37235d4091739d950c2693a)), closes [#239](https://github.com/jxsuite/jx/issues/239)
* **server:** resolve the references target against the server root, like its sibling ([bf86279](https://github.com/jxsuite/jx/commit/bf8627973f8e3298430ef37a4924932895f0e76b)), closes [#239](https://github.com/jxsuite/jx/issues/239)
* **server:** the preview origin builds its format registry from the project's config ([91c9ec6](https://github.com/jxsuite/jx/commit/91c9ec6ec316df22fd37bedecb37f83c3ea74d47))
* **studio:** stop stripping the project root off a reply that is already in it ([de84180](https://github.com/jxsuite/jx/commit/de84180d9225029e18dcebe25a352f550e309f79)), closes [#239](https://github.com/jxsuite/jx/issues/239)
* **studio:** the Packages table shows each dependency's own npm latest ([a90e170](https://github.com/jxsuite/jx/commit/a90e170392398c93926d94e092d7ec9ebe9b83e6))
* **studio:** the Packages table shows each dependency's own npm latest ([b019a26](https://github.com/jxsuite/jx/commit/b019a26848d06a92c9136f27a27edb2bea6e10dd))
* **studio:** the Packages table shows each dependency's own npm latest ([4fa433f](https://github.com/jxsuite/jx/commit/4fa433fba641973f2bfbeed99e16c4de96482b4a))


### Code Refactoring

* **schema,site:** site composition gets its own package ([f9d270d](https://github.com/jxsuite/jx/commit/f9d270daf261eef9ac9566192787b7a4bba25135))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.8.4
    * @jxsuite/compiler bumped to 3.0.0
    * @jxsuite/create bumped to 1.3.8
    * @jxsuite/import bumped to 0.40.0
    * @jxsuite/protocol bumped to 2.1.0
    * @jxsuite/runtime bumped to 3.0.0
    * @jxsuite/schema bumped to 2.0.0
    * @jxsuite/site bumped to 1.0.0
    * @jxsuite/starters bumped to 1.6.5
  * devDependencies
    * @jxsuite/auth bumped to 0.5.6
    * @jxsuite/connector bumped to 0.5.6
    * @jxsuite/parser bumped to 1.6.0

## [3.0.0](https://github.com/jxsuite/jx/compare/server-v2.2.7...server-v3.0.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **server:** a project relying on root-relative static serving loses it. The root lane survives as a COMPATIBILITY lane and is scheduled for removal; until then a site URL answered from it prints a diagnostic naming the file and the fix — move it into `public/`.

### Bug Fixes

* **server:** public/ resolves before the project root, as a build does ([2c123c6](https://github.com/jxsuite/jx/commit/2c123c6f09793311d6b99af2e59913bccdbf0cee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.8.3
    * @jxsuite/compiler bumped to 2.0.8
    * @jxsuite/create bumped to 1.3.7
    * @jxsuite/import bumped to 0.39.8
    * @jxsuite/protocol bumped to 2.0.0
    * @jxsuite/runtime bumped to 2.1.0
    * @jxsuite/schema bumped to 1.9.0
    * @jxsuite/starters bumped to 1.6.4
  * devDependencies
    * @jxsuite/auth bumped to 0.5.5
    * @jxsuite/connector bumped to 0.5.5
    * @jxsuite/parser bumped to 1.5.6

## [2.2.7](https://github.com/jxsuite/jx/compare/server-v2.2.6...server-v2.2.7) (2026-08-25)


### Bug Fixes

* **cloud:** discover components by reading them, so the canvas can register any ([#200](https://github.com/jxsuite/jx/issues/200)) ([e97b57d](https://github.com/jxsuite/jx/commit/e97b57db1ed2c9d8e1c103f6021ff332118d09be))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.8.2
    * @jxsuite/compiler bumped to 2.0.7
    * @jxsuite/create bumped to 1.3.6
    * @jxsuite/import bumped to 0.39.7
    * @jxsuite/protocol bumped to 1.2.1
    * @jxsuite/runtime bumped to 2.0.5
    * @jxsuite/schema bumped to 1.8.1
    * @jxsuite/starters bumped to 1.6.3
  * devDependencies
    * @jxsuite/auth bumped to 0.5.4
    * @jxsuite/connector bumped to 0.5.4
    * @jxsuite/parser bumped to 1.5.5

## [2.2.6](https://github.com/jxsuite/jx/compare/server-v2.2.5...server-v2.2.6) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.6
    * @jxsuite/import bumped to 0.39.6
  * devDependencies
    * @jxsuite/auth bumped to 0.5.3
    * @jxsuite/connector bumped to 0.5.3

## [2.2.5](https://github.com/jxsuite/jx/compare/server-v2.2.4...server-v2.2.5) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.5
    * @jxsuite/create bumped to 1.3.5
    * @jxsuite/import bumped to 0.39.5
    * @jxsuite/runtime bumped to 2.0.4
    * @jxsuite/starters bumped to 1.6.2
  * devDependencies
    * @jxsuite/parser bumped to 1.5.4

## [2.2.4](https://github.com/jxsuite/jx/compare/server-v2.2.3...server-v2.2.4) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.4
    * @jxsuite/create bumped to 1.3.4
    * @jxsuite/import bumped to 0.39.4
    * @jxsuite/protocol bumped to 1.2.0
    * @jxsuite/runtime bumped to 2.0.3
    * @jxsuite/starters bumped to 1.6.1
  * devDependencies
    * @jxsuite/parser bumped to 1.5.3

## [2.2.3](https://github.com/jxsuite/jx/compare/server-v2.2.2...server-v2.2.3) (2026-08-23)


### Bug Fixes

* **desktop:** a bare jx-studio watched the whole home directory ([b9d78d7](https://github.com/jxsuite/jx/commit/b9d78d74484c54ec6b983ab81bb19364d3a4a779))
* **desktop:** a bare jx-studio watched the whole home directory ([f60059b](https://github.com/jxsuite/jx/commit/f60059b86ba92341fe62f8280c24ae250fc891bc))

## [2.2.2](https://github.com/jxsuite/jx/compare/server-v2.2.1...server-v2.2.2) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/compiler bumped to 2.0.3
    * @jxsuite/create bumped to 1.3.3
    * @jxsuite/import bumped to 0.39.3
    * @jxsuite/starters bumped to 1.6.0

## [2.2.1](https://github.com/jxsuite/jx/compare/server-v2.2.0...server-v2.2.1) (2026-08-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.8.1
    * @jxsuite/compiler bumped to 2.0.2
    * @jxsuite/create bumped to 1.3.2
    * @jxsuite/import bumped to 0.39.2
    * @jxsuite/protocol bumped to 1.1.2
    * @jxsuite/runtime bumped to 2.0.2
    * @jxsuite/schema bumped to 1.8.0
    * @jxsuite/starters bumped to 1.5.0
  * devDependencies
    * @jxsuite/auth bumped to 0.5.2
    * @jxsuite/connector bumped to 0.5.2
    * @jxsuite/parser bumped to 1.5.2

## [2.2.0](https://github.com/jxsuite/jx/compare/server-v2.1.0...server-v2.2.0) (2026-08-21)


### Features

* **desktop:** bring the chromium launcher to PAL parity with electrobun ([9a94240](https://github.com/jxsuite/jx/commit/9a9424048403e48faf333e3ce788502ede4d2ce9))
* **desktop:** bring the chromium launcher to PAL parity with electrobun ([9846e1d](https://github.com/jxsuite/jx/commit/9846e1dcf8d94bb68082fa79f40d38c139689a91))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.8.0
    * @jxsuite/compiler bumped to 2.0.1
    * @jxsuite/create bumped to 1.3.1
    * @jxsuite/import bumped to 0.39.1
    * @jxsuite/protocol bumped to 1.1.1
    * @jxsuite/runtime bumped to 2.0.1
    * @jxsuite/schema bumped to 1.7.0
    * @jxsuite/starters bumped to 1.4.0
  * devDependencies
    * @jxsuite/auth bumped to 0.5.1
    * @jxsuite/connector bumped to 0.5.1
    * @jxsuite/parser bumped to 1.5.1

## [2.1.0](https://github.com/jxsuite/jx/compare/server-v2.0.0...server-v2.1.0) (2026-08-19)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **collab:** negotiate the wire envelope on the handshake — jx.collab.v1 ([5db8ae8](https://github.com/jxsuite/jx/commit/5db8ae8b781a1b5aeffbdd8f27cdf4c08ebb4540))
* **protocol:** one failure shape — RFC 9457 problem details ([2ab94b1](https://github.com/jxsuite/jx/commit/2ab94b189e1c1265f90713e36b8cb8030f9afd40))
* **schema:** serve markdown and YAML under the media types their RFCs register ([c336b6f](https://github.com/jxsuite/jx/commit/c336b6fc4e4935954cc897a3dc8d0579ad6ca27c))
* **server:** read Fetch Metadata, and close the three ungated project-server routes ([18bd5da](https://github.com/jxsuite/jx/commit/18bd5dab144d76c5c97b08fb43c28fb3e5ad127b))
* **server:** ship the Trusted Types observation stage (spec.md §21.5) ([cb563a5](https://github.com/jxsuite/jx/commit/cb563a5d3665cfde9fac34745f55f8b481c66416))
* **server:** the live-reload stream reconnects, and the import stream stops hiding drops ([af72f6f](https://github.com/jxsuite/jx/commit/af72f6f20f54d332434dd3550818ffc8d61f497d))
* **studio,server,desktop:** P4 wave A — the app can say what happened ([98a4a3a](https://github.com/jxsuite/jx/commit/98a4a3a1f895981ebc0b06483ef31953d8ebf7ef))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **parser:** localized content never reached its own locale's asset mount ([179311b](https://github.com/jxsuite/jx/commit/179311b3f56d001eea37c092d73956c20056c55d))
* **server:** give the previewed site its own origin, so Open in Browser is the real site ([90eb4b4](https://github.com/jxsuite/jx/commit/90eb4b4b3eba897a1028fa5a4029ef0dcae61f88))
* **studio:** the icon I deleted, the two I never fixed, and the checker that approved all three ([7452caa](https://github.com/jxsuite/jx/commit/7452caa09312674b523588c991d05116c8bc41f4))
* **studio:** the update prompt asks the registry, not this build's version number ([cea13c1](https://github.com/jxsuite/jx/commit/cea13c1f4ee9e4ad0ce7e937af290bbdd3973144))


### Reverts

* **studio:** stop reporting Trusted Types violations nobody can act on ([1ae1911](https://github.com/jxsuite/jx/commit/1ae19111b71b6d13f3659b925dfd12996910eb00))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.7.0
    * @jxsuite/compiler bumped to 2.0.0
    * @jxsuite/create bumped to 1.3.0
    * @jxsuite/import bumped to 0.39.0
    * @jxsuite/protocol bumped to 1.1.0
    * @jxsuite/runtime bumped to 2.0.0
    * @jxsuite/schema bumped to 1.6.0
    * @jxsuite/starters bumped to 1.3.0
  * devDependencies
    * @jxsuite/auth bumped to 0.5.0
    * @jxsuite/connector bumped to 0.5.0
    * @jxsuite/parser bumped to 1.5.0

## [2.0.0](https://github.com/jxsuite/jx/compare/server-v1.3.0...server-v2.0.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **studio:** `StudioPlatform` implementations must declare `createDestination` and honor `createProject`'s `destination`. `POST /__studio/create-project` rejects a request without one, and returns an absolute `root` for projects created outside the server root.

### Features

* **studio:** require a user-chosen destination for new projects ([e08966c](https://github.com/jxsuite/jx/commit/e08966cc2d7a7ba34d4b12f3a6186396539b07da))
* **studio:** upload and drop media from every editing surface ([ed5999b](https://github.com/jxsuite/jx/commit/ed5999b8522bcae408ac19c60d4758c40c7ff688))


### Bug Fixes

* **desktop,studio,server,collab:** typecheck the desktop package, and hold the coverage gates ([4a348b1](https://github.com/jxsuite/jx/commit/4a348b131be242ac14fe8097bb5cb431a9c64155))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **server:** let Studio open a project it does not already contain ([f55a22a](https://github.com/jxsuite/jx/commit/f55a22a4a2d5d30d29e75cff6133f0e20c29f973))
* **studio,server,desktop:** dev server bypassed the build; Monaco still loaded at startup ([288fb73](https://github.com/jxsuite/jx/commit/288fb73a0aae78318f17a4d1a24a73e0a523104e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.6.0
    * @jxsuite/compiler bumped to 1.5.0
    * @jxsuite/create bumped to 1.2.2
    * @jxsuite/import bumped to 0.38.2
    * @jxsuite/protocol bumped to 1.0.0
    * @jxsuite/runtime bumped to 1.3.2
    * @jxsuite/schema bumped to 1.5.0
    * @jxsuite/starters bumped to 1.2.2
  * devDependencies
    * @jxsuite/auth bumped to 0.4.2
    * @jxsuite/connector bumped to 0.4.2
    * @jxsuite/parser bumped to 1.4.1

## [1.3.0](https://github.com/jxsuite/jx/compare/server-v1.2.0...server-v1.3.0) (2026-07-24)


### Features

* support external/relative asset files ([368c909](https://github.com/jxsuite/jx/commit/368c9092214a2d589d20f7d2ddad03e698b76940))


### Bug Fixes

* **server:** resolve the oxlint binary robustly for the lint endpoint ([5e7e5e8](https://github.com/jxsuite/jx/commit/5e7e5e87a13857c794ef1b065f0e61496c8697b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.5.1
    * @jxsuite/compiler bumped to 1.4.0
    * @jxsuite/create bumped to 1.2.1
    * @jxsuite/import bumped to 0.38.1
    * @jxsuite/protocol bumped to 0.6.1
    * @jxsuite/runtime bumped to 1.3.1
    * @jxsuite/schema bumped to 1.4.0
    * @jxsuite/starters bumped to 1.2.1
  * devDependencies
    * @jxsuite/auth bumped to 0.4.1
    * @jxsuite/connector bumped to 0.4.1
    * @jxsuite/parser bumped to 1.4.0

## [1.2.0](https://github.com/jxsuite/jx/compare/server-v1.1.1...server-v1.2.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* harden dev server and unify runtime/compiler evaluation ([47a1d4c](https://github.com/jxsuite/jx/commit/47a1d4c90f29c6389049f389c97389857f24f855))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.5.0
    * @jxsuite/compiler bumped to 1.3.0
    * @jxsuite/create bumped to 1.2.0
    * @jxsuite/import bumped to 0.38.0
    * @jxsuite/protocol bumped to 0.6.0
    * @jxsuite/runtime bumped to 1.3.0
    * @jxsuite/schema bumped to 1.3.0
    * @jxsuite/starters bumped to 1.2.0
  * devDependencies
    * @jxsuite/auth bumped to 0.4.0
    * @jxsuite/connector bumped to 0.4.0
    * @jxsuite/parser bumped to 1.3.0

## [1.1.1](https://github.com/jxsuite/jx/compare/server-v1.1.0...server-v1.1.1) (2026-07-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.4.1
    * @jxsuite/compiler bumped to 1.2.0
    * @jxsuite/create bumped to 1.1.1
    * @jxsuite/import bumped to 0.37.1
    * @jxsuite/protocol bumped to 0.5.1
    * @jxsuite/runtime bumped to 1.2.0
    * @jxsuite/schema bumped to 1.2.0
    * @jxsuite/starters bumped to 1.1.1
  * devDependencies
    * @jxsuite/auth bumped to 0.3.1
    * @jxsuite/connector bumped to 0.3.1
    * @jxsuite/parser bumped to 1.2.0

## [1.1.0](https://github.com/jxsuite/jx/compare/server-v1.0.0...server-v1.1.0) (2026-07-17)


### Features

* **compiler,server,create:** jx dev and jx preview — the scaffolded scripts now work ([c0ff0d9](https://github.com/jxsuite/jx/commit/c0ff0d9d36715886b3f819b8d7ceebd682593583))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.4.0
    * @jxsuite/compiler bumped to 1.1.0
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/import bumped to 0.37.0
    * @jxsuite/protocol bumped to 0.5.0
    * @jxsuite/runtime bumped to 1.1.0
    * @jxsuite/schema bumped to 1.1.0
    * @jxsuite/starters bumped to 1.1.0
  * devDependencies
    * @jxsuite/auth bumped to 0.3.0
    * @jxsuite/connector bumped to 0.3.0
    * @jxsuite/parser bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/server-v0.37.1...server-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **studio:** data console — connections, schema push, secrets, data grid ([ea92f95](https://github.com/jxsuite/jx/commit/ea92f955cdfce5774a0ae72f01038e00c8d310ae))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.3.0
    - @jxsuite/compiler bumped to 1.0.0
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/import bumped to 0.36.0
    - @jxsuite/protocol bumped to 0.4.0
    - @jxsuite/runtime bumped to 1.0.0
    - @jxsuite/schema bumped to 1.0.0
    - @jxsuite/starters bumped to 1.0.0
  - devDependencies
    - @jxsuite/auth bumped to 0.2.0
    - @jxsuite/connector bumped to 0.2.0
    - @jxsuite/parser bumped to 1.0.0

## [0.37.1](https://github.com/jxsuite/jx/compare/server-v0.37.0...server-v0.37.1) (2026-07-08)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.1

## [0.37.0](https://github.com/jxsuite/jx/compare/server-v0.36.0...server-v0.37.0) (2026-07-08)

### Features

- **collab:** the wire — ws client/room core, devserver endpoint, adapter members ([d9f4b42](https://github.com/jxsuite/jx/commit/d9f4b425ac1d31cd3d7f9b2892e05321de08a09d))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.0

## [0.36.0](https://github.com/jxsuite/jx/compare/server-v0.35.0...server-v0.36.0) (2026-07-07)

### Features

- **studio:** AI managed mode — unlock the assistant from proxy state ([9af169f](https://github.com/jxsuite/jx/commit/9af169f2eba24c067ef713184371a3abcd55819c))
- **studio:** one-click Cloudflare Pages publish surface ([4b84d21](https://github.com/jxsuite/jx/commit/4b84d21da4e5bcc991593caf533565ec6419146c))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 0.35.0
    - @jxsuite/create bumped to 0.36.0
    - @jxsuite/import bumped to 0.35.1
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/runtime bumped to 0.34.2
    - @jxsuite/schema bumped to 0.35.0
    - @jxsuite/starters bumped to 0.35.1

## [0.35.0](https://github.com/jxsuite/jx/compare/server-v0.34.0...server-v0.35.0) (2026-07-06)

### Features

- site import package, ui + starter templates & wizard ([9c44e4a](https://github.com/jxsuite/jx/commit/9c44e4abe7e9d75c1129c179a419f5a390f86da9))
- **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))

### Bug Fixes

- **studio:** proper handling of relative component references ([eb20e2f](https://github.com/jxsuite/jx/commit/eb20e2f5ad5b8c27888f3b52d2ca76a24c5afb19))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/compiler bumped to 0.34.1
    - @jxsuite/create bumped to 0.35.0
    - @jxsuite/import bumped to 0.35.0
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/runtime bumped to 0.34.1
    - @jxsuite/starters bumped to 0.35.0
