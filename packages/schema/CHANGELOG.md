# Changelog

## [1.6.0](https://github.com/jxsuite/jx/compare/schema-v1.5.0...schema-v1.6.0) (2026-08-19)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **compiler:** an optional service worker, and the tombstone that removes it ([688e4fd](https://github.com/jxsuite/jx/commit/688e4fd5771d8b797c83e8a6ac5c64bcffc165a5))
* **compiler:** emit a Content-Security-Policy derived from the built pages ([139402b](https://github.com/jxsuite/jx/commit/139402bba057b3e74c65fb82dc70fc28d36370d6))
* **compiler:** emit dist/_headers and .nojekyll ([48ff636](https://github.com/jxsuite/jx/commit/48ff63657da9057caa89236d3310f5f925525699))
* **compiler:** generate manifest.webmanifest and .well-known/security.txt ([8e6dfca](https://github.com/jxsuite/jx/commit/8e6dfca829c4504047566b847e19b1326e452701))
* **compiler:** locale routing — the i18n config finally has a reader ([b806b4c](https://github.com/jxsuite/jx/commit/b806b4cc8cc4c41f0bb31bf90bc01c8d29a6e0bf))
* **compiler:** negotiate a locale, expand {locale} sources, and check prefix-always ([72f061c](https://github.com/jxsuite/jx/commit/72f061c9fe9cec6afc0a2c9dfa169e4245db4f24))
* **compiler:** opt into a shadow root with $shadow ([4a8f2e5](https://github.com/jxsuite/jx/commit/4a8f2e596a2648c55230f907783dd55092746bbb))
* **compiler:** responsive images — &lt;picture&gt; per format, one owner for loading ([14f920d](https://github.com/jxsuite/jx/commit/14f920de7d5a87ff6c8a71a6ab6c6c1a7820f7d7))
* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a localized slug is a translation, when the page says which one ([5d44fb7](https://github.com/jxsuite/jx/commit/5d44fb7062079a573456118ff8a3c7b44b987bf2))
* **i18n:** a page can render its own language switcher, and formats in its own language ([354e481](https://github.com/jxsuite/jx/commit/354e481b2bb45fc6be72d9af537d560c2f971d80))
* **i18n:** format for a language, and count what a reader sees ([fa8affd](https://github.com/jxsuite/jx/commit/fa8affdc2b1936d1ef9365379c490aa49608c552))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **runtime:** enforce private state against $props (spec.md §5.6) ([c8fffc5](https://github.com/jxsuite/jx/commit/c8fffc5a00a0b022717c81bc303b5331ca9b7488))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **schema:** normalize identifiers to NFC at the document parse boundary ([831874d](https://github.com/jxsuite/jx/commit/831874d472e1a9acc1e01b000e8962f20e62fcf9))
* **schema:** parse media types, and enforce I-JSON at the document boundary ([3e7db19](https://github.com/jxsuite/jx/commit/3e7db19e59825c200be4a337565875df4b58b5f9))
* **schema:** serve markdown and YAML under the media types their RFCs register ([c336b6f](https://github.com/jxsuite/jx/commit/c336b6fc4e4935954cc897a3dc8d0579ad6ca27c))
* **schema:** validate BCP 47 language tags at author time, not only at build time ([e62191d](https://github.com/jxsuite/jx/commit/e62191deda9032d8580a52f266eee1ef3e913500))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* **compiler:** package files in $head and $elements land in /assets/, not /node_modules/ ([038cc40](https://github.com/jxsuite/jx/commit/038cc40157174d92985ec2b40a84f604d17bc289))
* **compiler:** resolve the open issue sweep ([#121](https://github.com/jxsuite/jx/issues/121)–[#127](https://github.com/jxsuite/jx/issues/127)) ([2c0e044](https://github.com/jxsuite/jx/commit/2c0e04400a5ab99539ed5eb502512a837bc6b761))
* **parser:** localized content never reached its own locale's asset mount ([179311b](https://github.com/jxsuite/jx/commit/179311b3f56d001eea37c092d73956c20056c55d))
* **schema,studio:** five defects found by driving Studio against a real production site ([d28b49a](https://github.com/jxsuite/jx/commit/d28b49a33d95c2d8b11a33d8b8acdabd11729352))
* **schema:** redirects admits the shape the compiler and Studio write ([f6080ef](https://github.com/jxsuite/jx/commit/f6080eff7f8d82d715c5bdf5f7444ff4ea8d18f7))
* **schema:** the committed core schema is what its generator produces, and CI now says so ([57d804c](https://github.com/jxsuite/jx/commit/57d804c0d70eb81ea22906009fd3af151955d06a))

## [1.5.0](https://github.com/jxsuite/jx/compare/schema-v1.4.0...schema-v1.5.0) (2026-07-30)


### Features

* **schema:** make per-project schema composition host-agnostic ([4dddfa8](https://github.com/jxsuite/jx/commit/4dddfa8742bb43ddd8264d60b370d49aaa87bab1))
* **schema:** make per-project schema composition host-agnostic ([df337d8](https://github.com/jxsuite/jx/commit/df337d8b3f0c0da35cad16e76d52635f9f06d7c1))


### Bug Fixes

* **compiler:** close five adjacent element-target defects found while fixing [#106](https://github.com/jxsuite/jx/issues/106)-113 ([def35f6](https://github.com/jxsuite/jx/commit/def35f6e41f57524d637ba6331714e0fee6f9043))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))
* **studio,server,desktop:** dev server bypassed the build; Monaco still loaded at startup ([288fb73](https://github.com/jxsuite/jx/commit/288fb73a0aae78318f17a4d1a24a73e0a523104e))
* **studio:** keep the Data panel's Refresh able to fetch, and stop happy-dom loading canvas iframes ([08b149b](https://github.com/jxsuite/jx/commit/08b149b0273bcea8177b302b33e1a5bfb366779e))

## [1.4.0](https://github.com/jxsuite/jx/compare/schema-v1.3.0...schema-v1.4.0) (2026-07-24)


### Features

* support external/relative asset files ([368c909](https://github.com/jxsuite/jx/commit/368c9092214a2d589d20f7d2ddad03e698b76940))

## [1.3.0](https://github.com/jxsuite/jx/compare/schema-v1.2.0...schema-v1.3.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* harden dev server and unify runtime/compiler evaluation ([47a1d4c](https://github.com/jxsuite/jx/commit/47a1d4c90f29c6389049f389c97389857f24f855))
* **schema:** cover admission blocks, capability roles, and the rendering grammar ([ee6ccc1](https://github.com/jxsuite/jx/commit/ee6ccc13f6dfb579f5913273d61e02c13a8c6ba1))

## [1.2.0](https://github.com/jxsuite/jx/compare/schema-v1.1.0...schema-v1.2.0) (2026-07-18)


### Features

* color scheme support ([0f380c6](https://github.com/jxsuite/jx/commit/0f380c61a16c7bf0061628d0c7ccac5e3e045f4a))
* **compiler:** sidecar bundling, extension emit capability, heading anchors ([07e28bc](https://github.com/jxsuite/jx/commit/07e28bc37f3d96ffdc2d42a7f3fa4d5ceb9eb3de))
* search package ([9262c68](https://github.com/jxsuite/jx/commit/9262c68e5797ed1c4c2b9103e0f73e676a30ef39))
* **styling:** forced color-scheme contract — dual emission, color-scheme triplet, pre-paint script ([e629684](https://github.com/jxsuite/jx/commit/e629684da928ff18f710857601741c9c7db7585d))


### Bug Fixes

* nix build ([96987cd](https://github.com/jxsuite/jx/commit/96987cd8abc4e6058702bca8beed37d1ff80795f))
* **schema:** don't polute tree on schema generation ([9c96c85](https://github.com/jxsuite/jx/commit/9c96c85226fb785920853f2b713b301606d49f21))

## [1.1.0](https://github.com/jxsuite/jx/compare/schema-v1.0.0...schema-v1.1.0) (2026-07-17)


### Features

* **compiler,server,create:** jx dev and jx preview — the scaffolded scripts now work ([c0ff0d9](https://github.com/jxsuite/jx/commit/c0ff0d9d36715886b3f819b8d7ceebd682593583))
* **runtime,schema,formulas:** pure method operators and the composite formula catalog (spec §19.4d) ([58be3b1](https://github.com/jxsuite/jx/commit/58be3b1aac98ae50b7b1be543fa765c5c83adc46))
* **runtime,schema,studio:** blessed Intl helpers and object-literal expression operands ([e77a1f2](https://github.com/jxsuite/jx/commit/e77a1f233d28221a9e7b7209c234914d7988ef4d))
* **schema,runtime,studio:** structured function bodies and the statement editor (spec §20) ([1bc949a](https://github.com/jxsuite/jx/commit/1bc949ad6961513152066aee33d7a95f5a975fb2))
* **schema,runtime:** conditional operators and editor evaluation trace (spec §19.4b, §19.9) ([7992624](https://github.com/jxsuite/jx/commit/79926245807f27773e55da61374c05aa5f33dbd4))
* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))

## [1.0.0](https://github.com/jxsuite/jx/compare/schema-v0.35.0...schema-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- move @jxsuite/parser to the extensions/ tree
- hosts switch to the extension model; migrate all projects to content sections

### Features

- **connector:** dynamic data tables extension — Kysely core, /_jx/data mount, db push ([3085ab4](https://github.com/jxsuite/jx/commit/3085ab4d29c2c0c9f0b3a3007aadbd17da1994d4))
- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))
- **markup:** shared markup-conversion core package; sever studio/import from parser ([a075e74](https://github.com/jxsuite/jx/commit/a075e74a6c45e91b1d1c7c1a6007e2e344fbb341))
- move @jxsuite/parser to the extensions/ tree ([07cd6e0](https://github.com/jxsuite/jx/commit/07cd6e0ad1ef24fe60013de996e5cf0592ff1131))
- **schema:** manifest-driven extension registry ([ce04250](https://github.com/jxsuite/jx/commit/ce04250e6bf7819367c8957da8cf22312ad567ca))
- **schema:** shipped schema fragments + per-project schema emitters ([9e4a893](https://github.com/jxsuite/jx/commit/9e4a8936c4de73c6f1d0499c917340cfc6bf067a))
- **studio:** descriptor-contributed settings + fetched project schemas ([60f1465](https://github.com/jxsuite/jx/commit/60f1465cdc18c07c7d172372f4df2d67dee1ca88))

## [0.35.0](https://github.com/jxsuite/jx/compare/schema-v0.34.0...schema-v0.35.0) (2026-07-07)

### Features

- **schema:** build.deploy tracking block; fix stale adapter enum ([2c14856](https://github.com/jxsuite/jx/commit/2c148561f4f9329cb3e23d5d5fa3dc330fe121c5))
