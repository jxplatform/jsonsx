# Changelog

## [2.0.0](https://github.com/jxsuite/jx/compare/compiler-v1.5.0...compiler-v2.0.0) (2026-08-19)


### ⚠ BREAKING CHANGES

* **runtime:** #/state/a/b.c addresses member "b.c" of "a" rather than walking three levels. 451 of 452 pointers in the corpus are pure-slash and the one dotted ref was in the spec sentence describing the behavior.

### Features

* **compiler:** an optional service worker, and the tombstone that removes it ([688e4fd](https://github.com/jxsuite/jx/commit/688e4fd5771d8b797c83e8a6ac5c64bcffc165a5))
* **compiler:** check link relations against the IANA registry ([23c53a6](https://github.com/jxsuite/jx/commit/23c53a6422a58a8c54509cb29d769ca8e7f68e8e))
* **compiler:** compile $switch on a dynamic page ([#127](https://github.com/jxsuite/jx/issues/127)) ([d6c941b](https://github.com/jxsuite/jx/commit/d6c941b75357bac6d0a1bd25d8b0122a77c0469b))
* **compiler:** date a generated route by its entry, not by the template ([9bc9668](https://github.com/jxsuite/jx/commit/9bc96680634e56c150b4eeaede128f7abbf8885e))
* **compiler:** emit a Content-Security-Policy derived from the built pages ([139402b](https://github.com/jxsuite/jx/commit/139402bba057b3e74c65fb82dc70fc28d36370d6))
* **compiler:** emit dist/_headers and .nojekyll ([48ff636](https://github.com/jxsuite/jx/commit/48ff63657da9057caa89236d3310f5f925525699))
* **compiler:** generate manifest.webmanifest and .well-known/security.txt ([8e6dfca](https://github.com/jxsuite/jx/commit/8e6dfca829c4504047566b847e19b1326e452701))
* **compiler:** locale routing — the i18n config finally has a reader ([b806b4c](https://github.com/jxsuite/jx/commit/b806b4cc8cc4c41f0bb31bf90bc01c8d29a6e0bf))
* **compiler:** negotiate a locale, expand {locale} sources, and check prefix-always ([72f061c](https://github.com/jxsuite/jx/commit/72f061c9fe9cec6afc0a2c9dfa169e4245db4f24))
* **compiler:** opt into a shadow root with $shadow ([4a8f2e5](https://github.com/jxsuite/jx/commit/4a8f2e596a2648c55230f907783dd55092746bbb))
* **compiler:** responsive images — &lt;picture&gt; per format, one owner for loading ([14f920d](https://github.com/jxsuite/jx/commit/14f920de7d5a87ff6c8a71a6ab6c6c1a7820f7d7))
* **compiler:** serve the client runtime from the site, not from esm.sh ([b2ab1b1](https://github.com/jxsuite/jx/commit/b2ab1b136192ad55af1cd99cbad2899614ef4c6f))
* **compiler:** translated pages advertise each other ([106a924](https://github.com/jxsuite/jx/commit/106a924c3dd8023a1f0331f3aae4bdf1c07724ce))
* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a collection is localized end to end, and a starter proves it ([2230a01](https://github.com/jxsuite/jx/commit/2230a011b28743988725d061b7086cc02038cfb8))
* **i18n:** a localized slug is a translation, when the page says which one ([5d44fb7](https://github.com/jxsuite/jx/commit/5d44fb7062079a573456118ff8a3c7b44b987bf2))
* **i18n:** a page can render its own language switcher, and formats in its own language ([354e481](https://github.com/jxsuite/jx/commit/354e481b2bb45fc6be72d9af537d560c2f971d80))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **runtime:** enforce private state against $props (spec.md §5.6) ([c8fffc5](https://github.com/jxsuite/jx/commit/c8fffc5a00a0b022717c81bc303b5331ca9b7488))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **schema:** parse media types, and enforce I-JSON at the document boundary ([3e7db19](https://github.com/jxsuite/jx/commit/3e7db19e59825c200be4a337565875df4b58b5f9))
* **schema:** serve markdown and YAML under the media types their RFCs register ([c336b6f](https://github.com/jxsuite/jx/commit/c336b6fc4e4935954cc897a3dc8d0579ad6ca27c))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler,starters:** a project's own node_modules stops answering for the Jx schema ([42e07fb](https://github.com/jxsuite/jx/commit/42e07fb2cb9f7827bc0622dbb314c2be50625f3f))
* **compiler:** a runtime subpath asset that imports itself (site-architecture.md §8.7) ([d962487](https://github.com/jxsuite/jx/commit/d96248798e815d31ade36d869bf8f927be96e54c))
* **compiler:** emit IDL properties, and hoist shared branch subtrees ([#121](https://github.com/jxsuite/jx/issues/121), [#126](https://github.com/jxsuite/jx/issues/126)) ([67973be](https://github.com/jxsuite/jx/commit/67973be2af8b98e93b8d9c7ec18ccbc91f075a43))
* **compiler:** emit project style on the custom-element route ([#123](https://github.com/jxsuite/jx/issues/123)) ([eb8ebcb](https://github.com/jxsuite/jx/commit/eb8ebcb9d3499debb81931ba5011754d58d3e0e3))
* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* **compiler:** keep array state a runtime reader still needs ([#122](https://github.com/jxsuite/jx/issues/122)) ([8c5c1bb](https://github.com/jxsuite/jx/commit/8c5c1bb1e5ffb75553fe84d3acda800d470213c5))
* **compiler:** keep prerender from baking over mutable state ([#124](https://github.com/jxsuite/jx/issues/124), [#125](https://github.com/jxsuite/jx/issues/125)) ([b7d51cc](https://github.com/jxsuite/jx/commit/b7d51cc0f4a7f31758a6535766c3ca3a2d3dff20))
* **compiler:** make npm web components work in a built site ([9aa2e19](https://github.com/jxsuite/jx/commit/9aa2e198c1629b6d77ed5a63acd84947c329fdd7))
* **compiler:** package files in $head and $elements land in /assets/, not /node_modules/ ([038cc40](https://github.com/jxsuite/jx/commit/038cc40157174d92985ec2b40a84f604d17bc289))
* **compiler:** resolve the open issue sweep ([#121](https://github.com/jxsuite/jx/issues/121)–[#127](https://github.com/jxsuite/jx/issues/127)) ([2c0e044](https://github.com/jxsuite/jx/commit/2c0e04400a5ab99539ed5eb502512a837bc6b761))
* **compiler:** sitemap lastmod is a full RFC 3339 timestamp ([f0c7a22](https://github.com/jxsuite/jx/commit/f0c7a22447466fa83dc911b3727a390e036f8ab2))
* **desktop:** the Nix bundle deleted the extension packages it depends on ([cf3df55](https://github.com/jxsuite/jx/commit/cf3df5583ee50c1f18acd3d767c386e5ba63bd21))
* **parser:** localized content never reached its own locale's asset mount ([179311b](https://github.com/jxsuite/jx/commit/179311b3f56d001eea37c092d73956c20056c55d))
* **runtime:** one $ref tokenizer, so every lowered ref parses ([d57bed4](https://github.com/jxsuite/jx/commit/d57bed4495c0887b512a07d5e1b9f6e66c4462f3))
* **schema:** redirects admits the shape the compiler and Studio write ([f6080ef](https://github.com/jxsuite/jx/commit/f6080eff7f8d82d715c5bdf5f7444ff4ea8d18f7))
* **studio,compiler:** the disagree-with-itself families, and a computed the compiler never compiled ([784a58e](https://github.com/jxsuite/jx/commit/784a58e8f99cdd676e65d5b1261f7ea8883124b3))


### Reverts

* **studio:** stop reporting Trusted Types violations nobody can act on ([1ae1911](https://github.com/jxsuite/jx/commit/1ae19111b71b6d13f3659b925dfd12996910eb00))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.3.0
    * @jxsuite/runtime bumped to 2.0.0
    * @jxsuite/schema bumped to 1.6.0
  * devDependencies
    * @jxsuite/connector bumped to 0.5.0
    * @jxsuite/parser bumped to 1.5.0

## [1.5.0](https://github.com/jxsuite/jx/compare/compiler-v1.4.0...compiler-v1.5.0) (2026-07-30)


### Features

* better search results ([e62c11c](https://github.com/jxsuite/jx/commit/e62c11c902d8d048038a7d280e6dd3e70392e7a7))
* **schema:** make per-project schema composition host-agnostic ([4dddfa8](https://github.com/jxsuite/jx/commit/4dddfa8742bb43ddd8264d60b370d49aaa87bab1))
* **schema:** make per-project schema composition host-agnostic ([df337d8](https://github.com/jxsuite/jx/commit/df337d8b3f0c0da35cad16e76d52635f9f06d7c1))


### Bug Fixes

* **compiler:** close eight element-target and prerender conformance gaps ([456666b](https://github.com/jxsuite/jx/commit/456666bb5e962b75502c33573954b61e5d8bb0b0))
* **compiler:** close five adjacent element-target defects found while fixing [#106](https://github.com/jxsuite/jx/issues/106)-113 ([def35f6](https://github.com/jxsuite/jx/commit/def35f6e41f57524d637ba6331714e0fee6f9043))
* **compiler:** proper handling of white-space: pre ([4489f44](https://github.com/jxsuite/jx/commit/4489f44f18cd4ee5fbd0f80027645d7b9920f5bb))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.2.2
    * @jxsuite/runtime bumped to 1.3.2
    * @jxsuite/schema bumped to 1.5.0
  * devDependencies
    * @jxsuite/connector bumped to 0.4.2
    * @jxsuite/parser bumped to 1.4.1

## [1.4.0](https://github.com/jxsuite/jx/compare/compiler-v1.3.0...compiler-v1.4.0) (2026-07-24)


### Features

* support external/relative asset files ([368c909](https://github.com/jxsuite/jx/commit/368c9092214a2d589d20f7d2ddad03e698b76940))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.2.1
    * @jxsuite/runtime bumped to 1.3.1
    * @jxsuite/schema bumped to 1.4.0
  * devDependencies
    * @jxsuite/connector bumped to 0.4.1
    * @jxsuite/parser bumped to 1.4.0

## [1.3.0](https://github.com/jxsuite/jx/compare/compiler-v1.2.0...compiler-v1.3.0) (2026-07-22)


### Features

* **compiler:** bundled entry documents and whole-project jx validate ([46a5d6b](https://github.com/jxsuite/jx/commit/46a5d6b8dedb093612edebf240ed516882917b55))
* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* harden dev server and unify runtime/compiler evaluation ([47a1d4c](https://github.com/jxsuite/jx/commit/47a1d4c90f29c6389049f389c97389857f24f855))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.2.0
    * @jxsuite/runtime bumped to 1.3.0
    * @jxsuite/schema bumped to 1.3.0
  * devDependencies
    * @jxsuite/connector bumped to 0.4.0
    * @jxsuite/parser bumped to 1.3.0

## [1.2.0](https://github.com/jxsuite/jx/compare/compiler-v1.1.0...compiler-v1.2.0) (2026-07-18)


### Features

* color scheme support ([0f380c6](https://github.com/jxsuite/jx/commit/0f380c61a16c7bf0061628d0c7ccac5e3e045f4a))
* **compiler:** bundle the site worker self-contained per adapter ([4096ba1](https://github.com/jxsuite/jx/commit/4096ba1280d68e1e7915b1d24cab65784bf3f22a))
* **compiler:** sidecar bundling, extension emit capability, heading anchors ([07e28bc](https://github.com/jxsuite/jx/commit/07e28bc37f3d96ffdc2d42a7f3fa4d5ceb9eb3de))
* search package ([9262c68](https://github.com/jxsuite/jx/commit/9262c68e5797ed1c4c2b9103e0f73e676a30ef39))
* **styling:** forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script ([e629684](https://github.com/jxsuite/jx/commit/e629684da928ff18f710857601741c9c7db7585d))


### Bug Fixes

* **ci:** green the Test workflow — type-aware lint, coverage gates, docs drift ([78b3c17](https://github.com/jxsuite/jx/commit/78b3c170a656296b8b76655a289a25471376d6ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.1.1
    * @jxsuite/runtime bumped to 1.2.0
    * @jxsuite/schema bumped to 1.2.0
  * devDependencies
    * @jxsuite/connector bumped to 0.3.1
    * @jxsuite/parser bumped to 1.2.0

## [1.1.0](https://github.com/jxsuite/jx/compare/compiler-v1.0.0...compiler-v1.1.0) (2026-07-17)


### Features

* **compiler,server,create:** jx dev and jx preview — the scaffolded scripts now work ([c0ff0d9](https://github.com/jxsuite/jx/commit/c0ff0d9d36715886b3f819b8d7ceebd682593583))
* **docs,parser:** /docs platform — nested ids, nav sidebar, traceability, generated references ([6ecdcb5](https://github.com/jxsuite/jx/commit/6ecdcb505b7e61761369a12b76c51e27652df8e1))
* image pruning for persistent site build cache + github ci cache ([b45096e](https://github.com/jxsuite/jx/commit/b45096ede609ecb5d640143af4b777fcb7f661b8))
* **runtime,compiler:** named formulas — call operator, $args scheme, blessed globals ([24d516b](https://github.com/jxsuite/jx/commit/24d516bd3310fdd2630507b38d25a0a87d080e46))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Bug Fixes

* **studio,compiler,parser,protocol,auth:** keep the promises the docs audit surfaced ([03ac07f](https://github.com/jxsuite/jx/commit/03ac07ff3a53c125587050a277b3dfa7b0ce86b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @jxsuite/create bumped to 1.1.0
    * @jxsuite/runtime bumped to 1.1.0
    * @jxsuite/schema bumped to 1.1.0
  * devDependencies
    * @jxsuite/connector bumped to 0.3.0
    * @jxsuite/parser bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/compiler-v0.35.0...compiler-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- **auth:** Better Auth extension — sessions, permissions, auth-gated data ([bf47228](https://github.com/jxsuite/jx/commit/bf472285581afbfe7b650b5d52578078359655fa))
- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/create bumped to 1.0.0
    - @jxsuite/runtime bumped to 1.0.0
    - @jxsuite/schema bumped to 1.0.0
  - devDependencies
    - @jxsuite/connector bumped to 0.2.0
    - @jxsuite/parser bumped to 1.0.0

## [0.35.0](https://github.com/jxsuite/jx/compare/compiler-v0.34.1...compiler-v0.35.0) (2026-07-07)

### Features

- **schema:** build.deploy tracking block; fix stale adapter enum ([2c14856](https://github.com/jxsuite/jx/commit/2c148561f4f9329cb3e23d5d5fa3dc330fe121c5))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.1
    - @jxsuite/runtime bumped to 0.34.2
    - @jxsuite/schema bumped to 0.35.0

## [0.34.1](https://github.com/jxsuite/jx/compare/compiler-v0.34.0...compiler-v0.34.1) (2026-07-06)

### Bug Fixes

- **compiler:** proper handling of default content ([9970382](https://github.com/jxsuite/jx/commit/997038254e8247b963d22631117fb3639cdc1f6d))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @jxsuite/parser bumped to 0.35.0
    - @jxsuite/runtime bumped to 0.34.1
