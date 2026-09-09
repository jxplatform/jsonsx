# Changelog

## [1.7.1](https://github.com/jxsuite/jx/compare/starters-v1.7.0...starters-v1.7.1) (2026-09-09)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.8.0
    * @jxsuite/runtime bumped to 4.0.0
    * @jxsuite/schema bumped to 2.2.0

## [1.7.0](https://github.com/jxsuite/jx/compare/starters-v1.6.5...starters-v1.7.0) (2026-08-30)


### Features

* **parser,schema,server:** a format may declare rewrite, repairing a reference a CSV row names ([bca762e](https://github.com/jxsuite/jx/commit/bca762eea4a3a1cd55de02892b7db322155fb1ec))
* **parser,schema,server:** a format may declare rewrite, repairing a reference a CSV row names ([29a0f36](https://github.com/jxsuite/jx/commit/29a0f36a43319e294e2e69b14c694ff9796bdc5c)), closes [#246](https://github.com/jxsuite/jx/issues/246)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.7.0
    * @jxsuite/runtime bumped to 3.1.0
    * @jxsuite/schema bumped to 2.1.0

## [1.6.5](https://github.com/jxsuite/jx/compare/starters-v1.6.4...starters-v1.6.5) (2026-08-27)


### Performance Improvements

* **compiler:** minify bundles, inline component CSS, preload the runtime ([f19136e](https://github.com/jxsuite/jx/commit/f19136e35efb629c397923eccf959559af4d28b6))
* **compiler:** minify bundles, inline component CSS, preload the runtime ([f1a1537](https://github.com/jxsuite/jx/commit/f1a1537b1b7966892fa14cda9d1e3cfcb956cad4))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.6.0
    * @jxsuite/runtime bumped to 3.0.0
    * @jxsuite/schema bumped to 2.0.0

## [1.6.4](https://github.com/jxsuite/jx/compare/starters-v1.6.3...starters-v1.6.4) (2026-08-26)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.6
    * @jxsuite/runtime bumped to 2.1.0
    * @jxsuite/schema bumped to 1.9.0

## [1.6.3](https://github.com/jxsuite/jx/compare/starters-v1.6.2...starters-v1.6.3) (2026-08-25)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.5
    * @jxsuite/runtime bumped to 2.0.5
    * @jxsuite/schema bumped to 1.8.1

## [1.6.2](https://github.com/jxsuite/jx/compare/starters-v1.6.1...starters-v1.6.2) (2026-08-24)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.4
    * @jxsuite/runtime bumped to 2.0.4

## [1.6.1](https://github.com/jxsuite/jx/compare/starters-v1.6.0...starters-v1.6.1) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.3
    * @jxsuite/runtime bumped to 2.0.3

## [1.6.0](https://github.com/jxsuite/jx/compare/starters-v1.5.0...starters-v1.6.0) (2026-08-21)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **compiler:** emit dist/_headers and .nojekyll ([48ff636](https://github.com/jxsuite/jx/commit/48ff63657da9057caa89236d3310f5f925525699))
* **compiler:** responsive images — &lt;picture&gt; per format, one owner for loading ([14f920d](https://github.com/jxsuite/jx/commit/14f920de7d5a87ff6c8a71a6ab6c6c1a7820f7d7))
* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))
* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a collection is localized end to end, and a starter proves it ([2230a01](https://github.com/jxsuite/jx/commit/2230a011b28743988725d061b7086cc02038cfb8))
* **i18n:** a localized slug is a translation, when the page says which one ([5d44fb7](https://github.com/jxsuite/jx/commit/5d44fb7062079a573456118ff8a3c7b44b987bf2))
* **i18n:** format for a language, and count what a reader sees ([fa8affd](https://github.com/jxsuite/jx/commit/fa8affdc2b1936d1ef9365379c490aa49608c552))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **schema:** validate BCP 47 language tags at author time, not only at build time ([e62191d](https://github.com/jxsuite/jx/commit/e62191deda9032d8580a52f266eee1ef3e913500))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler,starters:** a project's own node_modules stops answering for the Jx schema ([42e07fb](https://github.com/jxsuite/jx/commit/42e07fb2cb9f7827bc0622dbb314c2be50625f3f))
* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* defects surfaced by fact-checking the new package READMEs ([c4a614d](https://github.com/jxsuite/jx/commit/c4a614dae5e199d49384f998a0b937354f9de882))
* **schema,studio:** five defects found by driving Studio against a real production site ([d28b49a](https://github.com/jxsuite/jx/commit/d28b49a33d95c2d8b11a33d8b8acdabd11729352))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** redirects admits the shape the compiler and Studio write ([f6080ef](https://github.com/jxsuite/jx/commit/f6080eff7f8d82d715c5bdf5f7444ff4ea8d18f7))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))
* **starters,examples:** repair documents the schema correctly rejected ([6913028](https://github.com/jxsuite/jx/commit/691302839526b4f1408ab98ca1b418b39784b01b))
* **starters:** pin template dependency ranges to the versions that released ([9ae71de](https://github.com/jxsuite/jx/commit/9ae71de8897bba2cdd626817d7271c03003bd5d7))

## [1.5.0](https://github.com/jxsuite/jx/compare/starters-v1.4.0...starters-v1.5.0) (2026-08-21)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **compiler:** emit dist/_headers and .nojekyll ([48ff636](https://github.com/jxsuite/jx/commit/48ff63657da9057caa89236d3310f5f925525699))
* **compiler:** responsive images — &lt;picture&gt; per format, one owner for loading ([14f920d](https://github.com/jxsuite/jx/commit/14f920de7d5a87ff6c8a71a6ab6c6c1a7820f7d7))
* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))
* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a collection is localized end to end, and a starter proves it ([2230a01](https://github.com/jxsuite/jx/commit/2230a011b28743988725d061b7086cc02038cfb8))
* **i18n:** a localized slug is a translation, when the page says which one ([5d44fb7](https://github.com/jxsuite/jx/commit/5d44fb7062079a573456118ff8a3c7b44b987bf2))
* **i18n:** format for a language, and count what a reader sees ([fa8affd](https://github.com/jxsuite/jx/commit/fa8affdc2b1936d1ef9365379c490aa49608c552))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **schema:** validate BCP 47 language tags at author time, not only at build time ([e62191d](https://github.com/jxsuite/jx/commit/e62191deda9032d8580a52f266eee1ef3e913500))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler,starters:** a project's own node_modules stops answering for the Jx schema ([42e07fb](https://github.com/jxsuite/jx/commit/42e07fb2cb9f7827bc0622dbb314c2be50625f3f))
* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* defects surfaced by fact-checking the new package READMEs ([c4a614d](https://github.com/jxsuite/jx/commit/c4a614dae5e199d49384f998a0b937354f9de882))
* **schema,studio:** five defects found by driving Studio against a real production site ([d28b49a](https://github.com/jxsuite/jx/commit/d28b49a33d95c2d8b11a33d8b8acdabd11729352))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** redirects admits the shape the compiler and Studio write ([f6080ef](https://github.com/jxsuite/jx/commit/f6080eff7f8d82d715c5bdf5f7444ff4ea8d18f7))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))
* **starters,examples:** repair documents the schema correctly rejected ([6913028](https://github.com/jxsuite/jx/commit/691302839526b4f1408ab98ca1b418b39784b01b))
* **starters:** pin template dependency ranges to the versions that released ([9ae71de](https://github.com/jxsuite/jx/commit/9ae71de8897bba2cdd626817d7271c03003bd5d7))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.2
    * @jxsuite/runtime bumped to 2.0.2
    * @jxsuite/schema bumped to 1.8.0

## [1.4.0](https://github.com/jxsuite/jx/compare/starters-v1.3.0...starters-v1.4.0) (2026-08-21)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **compiler:** emit dist/_headers and .nojekyll ([48ff636](https://github.com/jxsuite/jx/commit/48ff63657da9057caa89236d3310f5f925525699))
* **compiler:** responsive images — &lt;picture&gt; per format, one owner for loading ([14f920d](https://github.com/jxsuite/jx/commit/14f920de7d5a87ff6c8a71a6ab6c6c1a7820f7d7))
* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))
* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a collection is localized end to end, and a starter proves it ([2230a01](https://github.com/jxsuite/jx/commit/2230a011b28743988725d061b7086cc02038cfb8))
* **i18n:** a localized slug is a translation, when the page says which one ([5d44fb7](https://github.com/jxsuite/jx/commit/5d44fb7062079a573456118ff8a3c7b44b987bf2))
* **i18n:** format for a language, and count what a reader sees ([fa8affd](https://github.com/jxsuite/jx/commit/fa8affdc2b1936d1ef9365379c490aa49608c552))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **schema:** validate BCP 47 language tags at author time, not only at build time ([e62191d](https://github.com/jxsuite/jx/commit/e62191deda9032d8580a52f266eee1ef3e913500))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler,starters:** a project's own node_modules stops answering for the Jx schema ([42e07fb](https://github.com/jxsuite/jx/commit/42e07fb2cb9f7827bc0622dbb314c2be50625f3f))
* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* defects surfaced by fact-checking the new package READMEs ([c4a614d](https://github.com/jxsuite/jx/commit/c4a614dae5e199d49384f998a0b937354f9de882))
* **schema,studio:** five defects found by driving Studio against a real production site ([d28b49a](https://github.com/jxsuite/jx/commit/d28b49a33d95c2d8b11a33d8b8acdabd11729352))
* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** redirects admits the shape the compiler and Studio write ([f6080ef](https://github.com/jxsuite/jx/commit/f6080eff7f8d82d715c5bdf5f7444ff4ea8d18f7))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))
* **starters,examples:** repair documents the schema correctly rejected ([6913028](https://github.com/jxsuite/jx/commit/691302839526b4f1408ab98ca1b418b39784b01b))
* **starters:** pin template dependency ranges to the versions that released ([9ae71de](https://github.com/jxsuite/jx/commit/9ae71de8897bba2cdd626817d7271c03003bd5d7))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.1
    * @jxsuite/runtime bumped to 2.0.1
    * @jxsuite/schema bumped to 1.7.0

## [1.3.0](https://github.com/jxsuite/jx/compare/starters-v1.2.2...starters-v1.3.0) (2026-08-19)


### Features

* **auth:** a loopback redirect with PKCE, and cookies a browser will keep ([053f67c](https://github.com/jxsuite/jx/commit/053f67cf94216020dd2a39982cea30b3802ba3aa))
* **compiler:** emit dist/_headers and .nojekyll ([48ff636](https://github.com/jxsuite/jx/commit/48ff63657da9057caa89236d3310f5f925525699))
* **compiler:** responsive images — &lt;picture&gt; per format, one owner for loading ([14f920d](https://github.com/jxsuite/jx/commit/14f920de7d5a87ff6c8a71a6ab6c6c1a7820f7d7))
* **feed:** Atom and JSON Feed from content collections ([6269bce](https://github.com/jxsuite/jx/commit/6269bced4f79ca5bdf71ce97d4a404bfdd8523cc))
* **i18n:** a collection is localized end to end, and a starter proves it ([2230a01](https://github.com/jxsuite/jx/commit/2230a011b28743988725d061b7086cc02038cfb8))
* **i18n:** a localized slug is a translation, when the page says which one ([5d44fb7](https://github.com/jxsuite/jx/commit/5d44fb7062079a573456118ff8a3c7b44b987bf2))
* **i18n:** format for a language, and count what a reader sees ([fa8affd](https://github.com/jxsuite/jx/commit/fa8affdc2b1936d1ef9365379c490aa49608c552))
* **i18n:** multilingual sites, end to end — framework, Studio, extensions and a starter ([692e50f](https://github.com/jxsuite/jx/commit/692e50f9d7132daf71a63c950fd740b103766cb0))
* **schema,runtime,compiler,studio:** a tag can be chosen at element creation ([e31a20f](https://github.com/jxsuite/jx/commit/e31a20fb52b7e718be67ed59338d149abf3562c1))
* **schema:** validate BCP 47 language tags at author time, not only at build time ([e62191d](https://github.com/jxsuite/jx/commit/e62191deda9032d8580a52f266eee1ef3e913500))
* **studio:** the Named Shell — P0–P8, the full UX redesign ([b576cbb](https://github.com/jxsuite/jx/commit/b576cbb24c7e0d8d36075f6d682e9b3b6b971166))


### Bug Fixes

* **compiler,starters:** a project's own node_modules stops answering for the Jx schema ([42e07fb](https://github.com/jxsuite/jx/commit/42e07fb2cb9f7827bc0622dbb314c2be50625f3f))
* **compiler:** head identity, JSON-LD objects, and per-page lang ([61484bc](https://github.com/jxsuite/jx/commit/61484bcc4981eb51062c5fffc5c0574842140dd3))
* **schema,studio:** five defects found by driving Studio against a real production site ([d28b49a](https://github.com/jxsuite/jx/commit/d28b49a33d95c2d8b11a33d8b8acdabd11729352))
* **schema:** redirects admits the shape the compiler and Studio write ([f6080ef](https://github.com/jxsuite/jx/commit/f6080eff7f8d82d715c5bdf5f7444ff4ea8d18f7))
* **starters:** pin template dependency ranges to the versions that released ([9ae71de](https://github.com/jxsuite/jx/commit/9ae71de8897bba2cdd626817d7271c03003bd5d7))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/parser bumped to 1.5.0
    * @jxsuite/runtime bumped to 2.0.0
    * @jxsuite/schema bumped to 1.6.0

## [1.2.2](https://github.com/jxsuite/jx/compare/starters-v1.2.1...starters-v1.2.2) (2026-07-30)


### Bug Fixes

* **schema:** make committed entry documents resolve in editors ([3281908](https://github.com/jxsuite/jx/commit/328190812bb9716de5618da9365b4e4e43cfe7f0))
* **schema:** validate $paths against the source union instead of any object ([b801a9b](https://github.com/jxsuite/jx/commit/b801a9b503d2b116044b9e1d9b2f9ede9d99d5b7))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/schema bumped to 1.5.0

## [1.2.1](https://github.com/jxsuite/jx/compare/starters-v1.2.0...starters-v1.2.1) (2026-07-24)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/schema bumped to 1.4.0

## [1.2.0](https://github.com/jxsuite/jx/compare/starters-v1.1.1...starters-v1.2.0) (2026-07-22)


### Features

* enforce truthful marketing claims and add the missing LICENSE ([b7e0b09](https://github.com/jxsuite/jx/commit/b7e0b095566121d79ca50894b69a476984fb93ee))


### Bug Fixes

* **starters,examples:** repair documents the schema correctly rejected ([6913028](https://github.com/jxsuite/jx/commit/691302839526b4f1408ab98ca1b418b39784b01b))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/schema bumped to 1.3.0

## [1.1.1](https://github.com/jxsuite/jx/compare/starters-v1.1.0...starters-v1.1.1) (2026-07-18)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/schema bumped to 1.2.0

## [1.1.0](https://github.com/jxsuite/jx/compare/starters-v1.0.0...starters-v1.1.0) (2026-07-17)


### Features

* **studio:** spreadsheet grid editor — CSV grid tabs with batch save ([6736c02](https://github.com/jxsuite/jx/commit/6736c027d57fb438fb7aa0a9f333a41cc477e0a4))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @jxsuite/schema bumped to 1.1.0

## [1.0.0](https://github.com/jxsuite/jx/compare/starters-v0.35.1...starters-v1.0.0) (2026-07-13)

### ⚠ BREAKING CHANGES

- hosts switch to the extension model; migrate all projects to content sections

### Features

- hosts switch to the extension model; migrate all projects to content sections ([c40b45c](https://github.com/jxsuite/jx/commit/c40b45c2c1ac2052cba4467d9353de22f4c0f060))

### Dependencies

- The following workspace dependencies were updated
  - devDependencies
    - @jxsuite/schema bumped to 1.0.0

## [0.35.1](https://github.com/jxsuite/jx/compare/starters-v0.35.0...starters-v0.35.1) (2026-07-07)

### Dependencies

- The following workspace dependencies were updated
  - devDependencies
    - @jxsuite/schema bumped to 0.35.0

## [0.35.0](https://github.com/jxsuite/jx/compare/starters-v0.34.0...starters-v0.35.0) (2026-07-06)

### Features

- **starters:** init starter sites ([1f883b5](https://github.com/jxsuite/jx/commit/1f883b526ea91ae935de76932283302d0720f104))
- use site screenshots for template selector ([ba49dfa](https://github.com/jxsuite/jx/commit/ba49dfa9fec9c705bee3e87126acfefe197bcc74))
