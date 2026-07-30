# Changelog

## [2.0.0](https://github.com/jxsuite/jx/compare/studio-v1.5.0...studio-v2.0.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **studio:** `StudioPlatform` implementations must declare `createDestination` and honor `createProject`'s `destination`. `POST /__studio/create-project` rejects a request without one, and returns an absolute `root` for projects created outside the server root.

### Features

* **schema:** make per-project schema composition host-agnostic ([4dddfa8](https://github.com/jxsuite/jx/commit/4dddfa8742bb43ddd8264d60b370d49aaa87bab1))
* **schema:** make per-project schema composition host-agnostic ([df337d8](https://github.com/jxsuite/jx/commit/df337d8b3f0c0da35cad16e76d52635f9f06d7c1))
* **studio:** a preview link opens the real page in a real browser tab ([2d35120](https://github.com/jxsuite/jx/commit/2d35120c5faa11886d2aa06a54df48d0bb802903))
* **studio:** commit while typing, without moving the caret ([9dead59](https://github.com/jxsuite/jx/commit/9dead59d348d633b897cce9d0cf291caf2b42171))
* **studio:** derive the caret's editable tags from the document ([4d97c1f](https://github.com/jxsuite/jx/commit/4d97c1fa2dfe6fc1ac909c2112d89ef9f0962975))
* **studio:** edit across block boundaries ([7c0a8b9](https://github.com/jxsuite/jx/commit/7c0a8b96a7814c12e2a8a94870c0cb9b94681b8a))
* **studio:** give the canvas a document-wide caret ([6a4b470](https://github.com/jxsuite/jx/commit/6a4b4702fe09d42ffbe8f7735d8f786a136db4fb))
* **studio:** join blocks at their boundaries ([79e713d](https://github.com/jxsuite/jx/commit/79e713dbf6abf0ee813be2f2bb6594a39c2d15ff))
* **studio:** let the repo picker widen GitHub App repository access ([83f1f7e](https://github.com/jxsuite/jx/commit/83f1f7ea9e1cdc681e68111a6e40e71fdc0c1dca))
* **studio:** require a user-chosen destination for new projects ([e08966c](https://github.com/jxsuite/jx/commit/e08966cc2d7a7ba34d4b12f3a6186396539b07da))
* **studio:** upload and drop media from every editing surface ([ed5999b](https://github.com/jxsuite/jx/commit/ed5999b8522bcae408ac19c60d4758c40c7ff688))


### Bug Fixes

* **desktop,studio,server,collab:** typecheck the desktop package, and hold the coverage gates ([4a348b1](https://github.com/jxsuite/jx/commit/4a348b131be242ac14fe8097bb5cb431a9c64155))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))
* **server:** let Studio open a project it does not already contain ([f55a22a](https://github.com/jxsuite/jx/commit/f55a22a4a2d5d30d29e75cff6133f0e20c29f973))
* **studio,server,desktop:** dev server bypassed the build; Monaco still loaded at startup ([288fb73](https://github.com/jxsuite/jx/commit/288fb73a0aae78318f17a4d1a24a73e0a523104e))
* **studio:** clickable insertion helper target ([aca01db](https://github.com/jxsuite/jx/commit/aca01dbd3d5cbf3144617383df5994d92add76a2))
* **studio:** keep an anchor's URL when its block is edited ([ac89d16](https://github.com/jxsuite/jx/commit/ac89d1682c926420572330b44b9f914f4fee3614))
* **studio:** keep the Data panel's Refresh able to fetch, and stop happy-dom loading canvas iframes ([08b149b](https://github.com/jxsuite/jx/commit/08b149b0273bcea8177b302b33e1a5bfb366779e))
* **studio:** keep the welcome screen up until a project is opened ([20c549b](https://github.com/jxsuite/jx/commit/20c549b189f08228bec7a88b3b0969be5d26ee1c))
* **studio:** keep undo and the collab mirror usable at typing cadence ([197443d](https://github.com/jxsuite/jx/commit/197443d5d1e5e46ed6ff7b96d12c4df3f1b56a6c))
* **studio:** preview content-relative media at its mounted URL ([483eeb9](https://github.com/jxsuite/jx/commit/483eeb9d92d0dde160688278ebf5f465f7ca43f0))
* **studio:** register cloud platform inside studio.js for single-yjs collab ([11b73f3](https://github.com/jxsuite/jx/commit/11b73f337c508aca29b35e932660ce5255d6cadd))
* **studio:** register cloud platform inside studio.js for single-yjs collab ([f5d9c82](https://github.com/jxsuite/jx/commit/f5d9c821c70d8d6d5289de8fa4b4956b84f17c8a))
* **studio:** register cloud platform inside studio.js for single-yjs collab ([5179bd9](https://github.com/jxsuite/jx/commit/5179bd93c97b4123f27226213d629ae9cae347b4))
* **studio:** replace native prompts with a Spectrum prompt dialog ([4911fed](https://github.com/jxsuite/jx/commit/4911fed514bf1b518b836f8096f67fd0a7106165))
* **studio:** replace native prompts with a Spectrum prompt dialog ([c0bbc5e](https://github.com/jxsuite/jx/commit/c0bbc5ecd390d7b67d40bed523d6d6bd368cd8f1))
* **studio:** resolve project schemas offline and ship Monaco's workers everywhere ([bf04699](https://github.com/jxsuite/jx/commit/bf04699944b48e0523dc22890ebcbbbea25f0310))
* **studio:** stop the idle commit cancelling IME compositions; label the editable region ([0497c48](https://github.com/jxsuite/jx/commit/0497c488a5069db6341ffb9f7b5c190674cfa142))
* **studio:** undo a typing run that changed the block's shape ([47e438a](https://github.com/jxsuite/jx/commit/47e438a5a721026fb304bf3cda370e7ba8441169))


### Performance Improvements

* **studio,runtime:** stop refetching on every canvas render, narrow the splice escalation ([bad5b08](https://github.com/jxsuite/jx/commit/bad5b084884ffae3cff7e4d7a0dba1d43508314a))
* **studio:** build layer-row actions for the selected row, flatten the tree without spreads ([1c0ecac](https://github.com/jxsuite/jx/commit/1c0ecac1628c736d404713ed377b7f72a884e9b4))
* **studio:** coalesce canvas pointermove into a frame, drop the double-rAF ([54c9052](https://github.com/jxsuite/jx/commit/54c905270db99781ce5c279c0a3e1c51ce4c77d5))
* **studio:** code-split the bundle and load Monaco on demand ([78d85ba](https://github.com/jxsuite/jx/commit/78d85ba20569ff63ad279371923218f1ab7cc7b5))
* **studio:** instrument the render hot path, de-duplicate Monaco, stop shipping stale dist ([c9999b8](https://github.com/jxsuite/jx/commit/c9999b88a5557d7769694cb39c40e5630d42ca59))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.6.0
    * @jxsuite/create bumped to 1.2.2
    * @jxsuite/formulas bumped to 0.0.6
    * @jxsuite/markup bumped to 0.4.2
    * @jxsuite/protocol bumped to 1.0.0
    * @jxsuite/runtime bumped to 1.3.2
    * @jxsuite/schema bumped to 1.5.0

## [1.5.0](https://github.com/jxsuite/jx/compare/studio-v1.4.0...studio-v1.5.0) (2026-07-24)


### Features

* **studio:** Open Project repo picker + ship the editor shell in the npm package ([05154c7](https://github.com/jxsuite/jx/commit/05154c7f5a1cf1f8b42d1643fff8cc0fa96cfb2c))


### Bug Fixes

* **studio:** make New Project errors visible; add example entry point ([39f5a35](https://github.com/jxsuite/jx/commit/39f5a356240fd4b987a9a0919459dda1a48e6e79))
* **studio:** show validation errors in convert dialogs ([aebae6e](https://github.com/jxsuite/jx/commit/aebae6eab863bf6e0e5464dca36422e8eaa80be6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.5.1
    * @jxsuite/create bumped to 1.2.1
    * @jxsuite/formulas bumped to 0.0.5
    * @jxsuite/markup bumped to 0.4.1
    * @jxsuite/protocol bumped to 0.6.1
    * @jxsuite/runtime bumped to 1.3.1
    * @jxsuite/schema bumped to 1.4.0

## [1.4.0](https://github.com/jxsuite/jx/compare/studio-v1.3.0...studio-v1.4.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/ai bumped to 0.34.0
    * @jxsuite/collab bumped to 0.5.0
    * @jxsuite/create bumped to 1.2.0
    * @jxsuite/formulas bumped to 0.0.4
    * @jxsuite/markup bumped to 0.4.0
    * @jxsuite/protocol bumped to 0.6.0
    * @jxsuite/runtime bumped to 1.3.0
    * @jxsuite/schema bumped to 1.3.0

## [1.3.0](https://github.com/jxsuite/jx/compare/studio-v1.2.0...studio-v1.3.0) (2026-07-20)


### Features

* **screenshots,studio:** staged captures for AI, data, publish, and collab docs ([50fdfce](https://github.com/jxsuite/jx/commit/50fdfce5e8c6271cef42902ab603ffa97d123612))
* **screenshots,studio:** tranche-2 interaction captures + runner and palette fixes ([18d8ca8](https://github.com/jxsuite/jx/commit/18d8ca8efcc2c63f88f8301ec4e91e813956c8d8))


### Bug Fixes

* **studio:** add !project guard to cloud PAL adapter's subscribeFileEvents ([39010f9](https://github.com/jxsuite/jx/commit/39010f9c91997ff03d58fc5765cfd781e462052e))

## [1.2.0](https://github.com/jxsuite/jx/compare/studio-v1.1.0...studio-v1.2.0) (2026-07-18)


### Features

* **studio:** color-scheme canvas preview — Auto/Light/Dark tab-bar control ([a5f96ba](https://github.com/jxsuite/jx/commit/a5f96ba6f28918b4bd3540ddeb979df3cac5336a))
* **studio:** color-scheme canvas preview — Auto/Light/Dark tab-bar control ([ccdc1d3](https://github.com/jxsuite/jx/commit/ccdc1d3ec72b3903f9a976b2556d64a6380f2b7c))
* **studio:** scheme-variant editing — token overrides, scheme-layer routing, live feedback ([49f0c52](https://github.com/jxsuite/jx/commit/49f0c525c47b130cd773cfdf8501eb3cc4c329f2))


### Bug Fixes

* **tests:** tsc errors — typed children access in highlight tests, colorScheme in stylebook message ([767215e](https://github.com/jxsuite/jx/commit/767215e3f776b0894b13cfc2e04190b7e2824464))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.4.1
    * @jxsuite/create bumped to 1.1.1
    * @jxsuite/formulas bumped to 0.0.3
    * @jxsuite/markup bumped to 0.3.1
    * @jxsuite/protocol bumped to 0.5.1
    * @jxsuite/runtime bumped to 1.2.0
    * @jxsuite/schema bumped to 1.2.0

## [1.1.0](https://github.com/jxsuite/jx/compare/studio-v1.0.0...studio-v1.1.0) (2026-07-17)


### Features

* **formulas:** packaging, docs, and studio copy-in consumption ([f5df14f](https://github.com/jxsuite/jx/commit/f5df14f125b2fca2224cce68aa4674b3c7d9071a))
* **runtime,schema,formulas:** pure method operators and the composite formula catalog (spec §19.4d) ([58be3b1](https://github.com/jxsuite/jx/commit/58be3b1aac98ae50b7b1be543fa765c5c83adc46))
* **runtime,schema,studio:** blessed Intl helpers and object-literal expression operands ([e77a1f2](https://github.com/jxsuite/jx/commit/e77a1f233d28221a9e7b7209c234914d7988ef4d))
* **schema,runtime,studio:** structured function bodies and the statement editor (spec §20) ([1bc949a](https://github.com/jxsuite/jx/commit/1bc949ad6961513152066aee33d7a95f5a975fb2))
* **studio:** collection grids with rich cells — bulk frontmatter editing ([28dc589](https://github.com/jxsuite/jx/commit/28dc58950e1d2d7f44ed0d876f51a47dc22c189f))
* **studio:** consolidated field mode switcher ([0a135ed](https://github.com/jxsuite/jx/commit/0a135ed1a689d2c7fa6588833dc5c9da504a6a65))
* **studio:** dedicated zoom level on editor mode ([72ec8b7](https://github.com/jxsuite/jx/commit/72ec8b768f536e8c502d6fb6ec388f931f7af272))
* **studio:** dynamic-slot control and live expression value badges ([d7bd673](https://github.com/jxsuite/jx/commit/d7bd673b3fa1c07cf43b52902f3fa29616b234c8))
* **studio:** formula catalog, search palette, chip pipeline, fx everywhere ([c588391](https://github.com/jxsuite/jx/commit/c5883918d04565d25098d9a3c812b6f14ee7a16b))
* **studio:** full-screen formula workspace ([d6195eb](https://github.com/jxsuite/jx/commit/d6195eb160b5d07d86229fe532d444ab963a96d3))
* **studio:** grid polish — find & replace, column layout persistence ([fe5f223](https://github.com/jxsuite/jx/commit/fe5f2232c5ea007ceb1e3e59a1b4328f8dc9525f))
* **studio:** inline editing of component property bound text ([898dbcb](https://github.com/jxsuite/jx/commit/898dbcbff5a9db6e1f4369515bec1f52baa2fa70))
* **studio:** live-context expression previews and component test props ([8e502c2](https://github.com/jxsuite/jx/commit/8e502c236be9538eb1a2ca1f8f2caec2ae50bc6b))
* **studio:** pages + connector grid tabs; the modal data grid retires ([a341ab3](https://github.com/jxsuite/jx/commit/a341ab301ac6e03a9073517c7f49bce4e0eb9cd1))
* **studio:** persistent ai sidebar + project bootstrap capabilities ([3d6f9eb](https://github.com/jxsuite/jx/commit/3d6f9ebf40c88a34939b9ed525618931b700a25c))
* **studio:** properties panel for content type frontmatter/metadata ([2ef24f4](https://github.com/jxsuite/jx/commit/2ef24f4075653b2cee4ee361db0ad3fb6f733090))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))
* **studio:** wheel-scrollable tab strip + active-tab reveal ([09c5c3b](https://github.com/jxsuite/jx/commit/09c5c3bb500e8b1548b09e0996b73a130d8f2069))


### Bug Fixes

* **studio,compiler,parser,protocol,auth:** keep the promises the docs audit surfaced ([03ac07f](https://github.com/jxsuite/jx/commit/03ac07ff3a53c125587050a277b3dfa7b0ce86b6))
* **studio:** component registry regression ([ac3ff48](https://github.com/jxsuite/jx/commit/ac3ff48719ca476b0f33510664fb375e4a7fd11e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/collab bumped to 0.4.0
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/formulas bumped to 0.0.2
    * @jxsuite/markup bumped to 0.3.0
    * @jxsuite/protocol bumped to 0.5.0
    * @jxsuite/runtime bumped to 1.1.0
    * @jxsuite/schema bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/studio-v0.37.1...studio-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- **studio:** add/open existing repositories from the welcome screen ([4edc293](https://github.com/jxsuite/jx/commit/4edc293d439cf613060b4113b10973251785c3e7))
- **studio:** data console — connections, schema push, secrets, data grid ([ea92f95](https://github.com/jxsuite/jx/commit/ea92f955cdfce5774a0ae72f01038e00c8d310ae))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))
- **studio:** instant CF connect handshake + Connect-Cloudflare option in the AI gate ([f7de0a3](https://github.com/jxsuite/jx/commit/f7de0a3fecb2a375ff9984446243ac157fe10db9))
- **studio:** prompt for GitHub App installation from the project UI ([850f8cb](https://github.com/jxsuite/jx/commit/850f8cba4c40d2b3ecab425633a2ec49f966190e))
- **studio:** reusable schema-form engine, context resolver, settings registry ([4cb1d63](https://github.com/jxsuite/jx/commit/4cb1d63d70fc16535646897466e1a2fb1719157c))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.3.0
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/markup bumped to 0.2.0
    - @jxsuite/protocol bumped to 0.4.0
    - @jxsuite/runtime bumped to 1.0.0
    - @jxsuite/schema bumped to 1.0.0

## [0.37.1](https://github.com/jxsuite/jx/compare/studio-v0.37.0...studio-v0.37.1) (2026-07-08)

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.1
    - @jxsuite/protocol bumped to 0.3.1

## [0.37.0](https://github.com/jxsuite/jx/compare/studio-v0.36.0...studio-v0.37.0) (2026-07-08)

### Features

- **collab:** @jxsuite/collab — Y.Doc schema, op bridge, differ, wire envelope ([0166c38](https://github.com/jxsuite/jx/commit/0166c38f05b87bb96595a30ee1cbc31781e8cc82))
- **collab:** the wire — ws client/room core, devserver endpoint, adapter members ([d9f4b42](https://github.com/jxsuite/jx/commit/d9f4b425ac1d31cd3d7f9b2892e05321de08a09d))
- **studio:** adopt y-monaco for source co-editing ([63c2557](https://github.com/jxsuite/jx/commit/63c2557a1adab984b09bbc3e8f164b88b8dd0c68))
- **studio:** collab seams in the transact pipeline ([f9b6db6](https://github.com/jxsuite/jx/commit/f9b6db6e2ca01bbeaea2b461a27591f2fdd3965c))
- **studio:** CollabSession — realtime co-editing behind platform.collab ([6e56521](https://github.com/jxsuite/jx/commit/6e56521e06e871057762d19936d9832bdfbe9c67))
- **studio:** presence UX — chips, remote selection overlays, sync status ([d458d72](https://github.com/jxsuite/jx/commit/d458d7249c5de0424fe73c4e5090448de6526cd7))
- **studio:** source-mode co-editing under the canonical lock ([478d148](https://github.com/jxsuite/jx/commit/478d148105a8e7545197b83626876d85e5218019))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/collab bumped to 0.2.0
    - @jxsuite/protocol bumped to 0.3.0

## [0.36.0](https://github.com/jxsuite/jx/compare/studio-v0.35.0...studio-v0.36.0) (2026-07-07)

### Features

- **protocol:** @jxsuite/protocol — the Studio Backend Protocol package ([e859f36](https://github.com/jxsuite/jx/commit/e859f36eecead91de37ff6ec9ea51e7d3ca0691c))
- **studio:** AI managed mode — unlock the assistant from proxy state ([9af169f](https://github.com/jxsuite/jx/commit/9af169f2eba24c067ef713184371a3abcd55819c))
- **studio:** cloud platform adapter — @jxsuite/studio/platforms/cloud ([4bfd5a0](https://github.com/jxsuite/jx/commit/4bfd5a0cedc301f7025a33e3a04bb2597b1d0f46))
- **studio:** one-click Cloudflare Pages publish surface ([4b84d21](https://github.com/jxsuite/jx/commit/4b84d21da4e5bcc991593caf533565ec6419146c))
- **studio:** platform project catalogue on the welcome screen ([18c6a43](https://github.com/jxsuite/jx/commit/18c6a43ab1c2a1fba282d023a93fe47810afc088))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/create bumped to 0.36.0
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/protocol bumped to 0.2.0
    - @jxsuite/runtime bumped to 0.34.2
    - @jxsuite/schema bumped to 0.35.0

## [0.35.0](https://github.com/jxsuite/jx/compare/studio-v0.34.0...studio-v0.35.0) (2026-07-06)

### Features

- automated screenshot framework ([0f8c972](https://github.com/jxsuite/jx/commit/0f8c9721e97bdeeb5c883d86a0f175393718b71e))
- **desktop:** persistent cross-platform user settings ([352cf36](https://github.com/jxsuite/jx/commit/352cf3636d7d1a132d847db1b15703c6be9fa30a))
- site import package, ui + starter templates & wizard ([9c44e4a](https://github.com/jxsuite/jx/commit/9c44e4abe7e9d75c1129c179a419f5a390f86da9))
- **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))
- **studio:** agentic ai history switcher, modern UI/UX ([2f1bd61](https://github.com/jxsuite/jx/commit/2f1bd61297d8b5ff9f60735b674e5f31eb50d039))
- **studio:** auto-sync and package conflict resolution ([5fb5fe4](https://github.com/jxsuite/jx/commit/5fb5fe42466a6f2bd9b6cabad2047daf18febf80))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/runtime bumped to 0.34.1
