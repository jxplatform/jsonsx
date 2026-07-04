# Changelog

## [0.35.0](https://github.com/jxsuite/jx/compare/v0.34.0...v0.35.0) (2026-07-04)


### Features

* automated screenshot framework ([0f8c972](https://github.com/jxsuite/jx/commit/0f8c9721e97bdeeb5c883d86a0f175393718b71e))
* **desktop:** wire up the "new project" feature ([5f9fec3](https://github.com/jxsuite/jx/commit/5f9fec325269ebada329f383825f096db657610f))
* **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))
* **studio:** auto-sync and package conflict resolution ([5fb5fe4](https://github.com/jxsuite/jx/commit/5fb5fe42466a6f2bd9b6cabad2047daf18febf80))
* use site screenshots for template selector ([ba49dfa](https://github.com/jxsuite/jx/commit/ba49dfa9fec9c705bee3e87126acfefe197bcc74))


### Bug Fixes

* **compiler:** proper handling of default content ([9970382](https://github.com/jxsuite/jx/commit/997038254e8247b963d22631117fb3639cdc1f6d))
* **runtime:** proper handling of default content ([73ddb02](https://github.com/jxsuite/jx/commit/73ddb02eed74c69587739eb8f257736e30001158))
* **studio:** proper handling of relative component references ([eb20e2f](https://github.com/jxsuite/jx/commit/eb20e2f5ad5b8c27888f3b52d2ca76a24c5afb19))

## [0.34.0](https://github.com/jxsuite/jx/compare/v0.33.0...v0.34.0) (2026-07-03)


### Features

* **studio:** bindings control on the signals panel ([f6d2cf3](https://github.com/jxsuite/jx/commit/f6d2cf3c353ace021cea8ac9a31089ad9606eca4))
* **studio:** enrich properties-panel link handling (Phase 9 [#4](https://github.com/jxsuite/jx/issues/4)b) ([e840a6d](https://github.com/jxsuite/jx/commit/e840a6db3627873d58cbfa7813d9029425ba6cfb))
* **studio:** preview toggle on all edit modes ([8b57ce2](https://github.com/jxsuite/jx/commit/8b57ce20a11ca00b89834f513f065a6ac4749b78))
* **studio:** schema-driven repeater merge-tag scope (Phase 9 [#4](https://github.com/jxsuite/jx/issues/4)a) ([5e75798](https://github.com/jxsuite/jx/commit/5e75798791cbee9c3de8834707c9f6b5aa21c7f6))


### Bug Fixes

* better surgical patching on canvas ([ffafbc6](https://github.com/jxsuite/jx/commit/ffafbc63a2446e973c925be4d5ef1978618df786))
* context separation between component instances and component editing ([2135407](https://github.com/jxsuite/jx/commit/2135407cbe3438995815f8e5d250afb9c67c136f))
* **desktop:** chromium-build welcome screen and project class loading ([d8ef9fb](https://github.com/jxsuite/jx/commit/d8ef9fbfc3328dbfc05127069a68e76f3eef4c75))
* **desktop:** disable site isolation so the canvas iframe drag cursor works ([be0f199](https://github.com/jxsuite/jx/commit/be0f199b56d9d117fcc2ea76f030d3e8249afa05))
* **desktop:** iframe-based document opening in chromium build ([d1b6e5e](https://github.com/jxsuite/jx/commit/d1b6e5e2593ff39eb3dd8dffbe1a5704d16052cd))
* **desktop:** thread rpcToken onto chromium canvas iframe URL (Phase 9 [#3](https://github.com/jxsuite/jx/issues/3)) ([c6526ce](https://github.com/jxsuite/jx/commit/c6526ce767465691ade9e4fc0bafeaad4d058028))
* feature parity with the non-iframe studio ([f98eb82](https://github.com/jxsuite/jx/commit/f98eb829de3b5814909c1bfdd639661e40dc85d5))
* **server:** serve studio assets with Referrer-Policy same-origin, not no-referrer ([bdbb33a](https://github.com/jxsuite/jx/commit/bdbb33a6c1b7beb09333117040db51a400f3c932))
* **studio,desktop:** route parent preview &lt;img&gt; through loopback origin (Phase 9 [#2](https://github.com/jxsuite/jx/issues/2)) ([0151787](https://github.com/jxsuite/jx/commit/01517877c4675aa85d3e344963bf8454f7738214))
* **studio,runtime:** own render effects with the runtime's reactive scope ([37676d3](https://github.com/jxsuite/jx/commit/37676d38b865348546645ad3d4447f816873a9dd))
* **studio,runtime:** re-post dataScope when async data sources settle ([0a93015](https://github.com/jxsuite/jx/commit/0a93015c280b4749d85064c8bab2f400d547ef34))
* **studio:** component canvas matches component size ([b5fe2b8](https://github.com/jxsuite/jx/commit/b5fe2b83b927432d5858c9c233e9190e9b82bbef))
* **studio:** plain-copy the drag src path before it crosses postMessage ([db787ee](https://github.com/jxsuite/jx/commit/db787eebb7c0327bb566b3550a0a96bdfa526ed9))
* **studio:** restore dynamic data-source loading in the data-explorer ([b79f516](https://github.com/jxsuite/jx/commit/b79f516bac12f6677c83b570da06c2cf6512656d))
* **studio:** route native drag streams through the canvas iframe ([7b494fc](https://github.com/jxsuite/jx/commit/7b494fccb48126836257f68264d0b95d4d4ccc66))
* **studio:** stop native drags from hijacking iframe drag-reorder ([c16bcc7](https://github.com/jxsuite/jx/commit/c16bcc7f898df7bd05d0eed51d613bb8fd946abb))

## [0.33.0](https://github.com/jxsuite/jx/compare/v0.32.0...v0.33.0) (2026-07-01)

### Features

- **compiler:** sitemap generation ([948c7a6](https://github.com/jxsuite/jx/commit/948c7a6783811b54604ccec99772e910a938f211))
- openai-compatible ai assistant tooling ([2b5d0b2](https://github.com/jxsuite/jx/commit/2b5d0b2613fa22f5d849848a1b8852aeff1e52fa))
- openai-compatible ai assistant tooling ([92ca325](https://github.com/jxsuite/jx/commit/92ca325fb53218e05f6cbeb5277c3063903f53f5))

### Bug Fixes

- **studio:** fix post-spectrum panel resizing ([9c985ae](https://github.com/jxsuite/jx/commit/9c985ae3e8f18effcdaac44b666aceb5b0dd1b03))
