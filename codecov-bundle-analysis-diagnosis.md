# Codecov Bundle Analysis — Diagnosis Report

- **Repo:** `jxsuite/jx` (public)
- **Date:** 2026-07-02
- **Scope:** Why PR bundle reports show "+100%" on every PR while the
  `bundles/main` dashboard is empty.
- **Verdict:** Not a bug in our build, CI, or the uploader. Push /
  default-branch bundle uploads are accepted and stored by Codecov but its
  async worker produces an **empty** report for them, so `main` never gets a
  baseline. This is a **Codecov-side processing issue** for tokenless v3
  bundle uploads outside a PR context.

---

## Symptoms

1. Every PR's Codecov "Bundle Report" comment says the change **increases total
   bundle size by ~100%** (e.g. PR #67: "+15.53MB (100.0%)", with each bundle —
   parser 2.84MB, studio 12.16MB, etc. — shown as "+100%").
2. `https://app.codecov.io/github/jxsuite/jx/bundles/main` shows **no data**.

Both are the same problem: **`main` has no populated bundle baseline**, so a PR's
entire bundle reads as newly-added (base = 0 → +100%), and the branch dashboard
has nothing to render.

## How bundle analysis is wired

`.github/workflows/bundle-analysis.yml` runs a 4-package matrix
(compiler/parser/runtime/studio) on `push: [main]` and `pull_request`:

- `bun run build:metafile` → `metafile.json` per package
- `bunx metafile-codecov -f metafile.json -n <pkg> --output-dir dist
--bundler-name bun --bundler-version <v> --upload`

The tool [`metafile-codecov-bundle`](https://github.com/jbergstroem/metafile-codecov-bundle)
(a third-party, Bun-friendly reimplementation — Codecov has no Bun bundler
plugin) converts the metafile into Codecov's **v3 bundle payload** and uploads
it tokenlessly via GitHub Actions **OIDC** (POST to
`https://api.codecov.io/upload/bundle_analysis/v1` for a presigned URL, then PUT
the payload to storage).

## Root cause

On a **push to `main`** (`pr:""`), the upload is byte-for-byte correct, Codecov
**accepts and queues it (HTTP 202)**, the payload **PUTs 200 OK** into storage,
and the commit is **fully known** to Codecov (coverage processed) — yet the
resulting bundle report is **empty** (`size 0`, `bundles []`). The _identical_
upload path on a **`pull_request`** event produces a **full** report. The only
material difference is the event/PR context. Nothing the client controls is
wrong; the report is emptied during Codecov's async processing of
push/default-branch uploads.

## Evidence

**PR side works — but data lands on the throwaway merge commit.**
For PR #67, Codecov's "head" commit is `ff9c5df85a8ccb747989d538dbdc5c2f9e5fac12`,
which is exactly the PR's `merge_commit_sha` (`refs/pull/67/merge`), and that SHA
holds the **full report: 15,527,176 bytes** (parser/compiler/runtime/studio).
The PR's real head commit `a5dfe49e…` has an **empty** report. The uploader tags
uploads with `GITHUB_SHA`, which on `pull_request` events is the ephemeral merge
ref, not `github.event.pull_request.head.sha`. (Cosmetic/correctness issue; not
the cause of the +100%.)

**`main` side is uniformly empty.** Every `main` commit's bundle report is
`size 0` / `bundles []`:

| commit                             | note                          | bundle report |
| ---------------------------------- | ----------------------------- | ------------- |
| `d0ae4199`                         | "chore: update deps" (push)   | empty (0)     |
| `c067104d`                         | "release 0.33.0" merge (push) | empty (0)     |
| `e5aabc9b`                         | "chore: update deps" (push)   | empty (0)     |
| `264f9e8d`, `2b5d0b26`, `9c985ae3` | older main                    | empty / none  |

Not a processing delay — commits days old are equally empty.

**The upload itself is healthy (instrumented run on `d0ae4199`, push, `pr:""`):**

```
GITHUB_EVENT_NAME = push
service params: { branch:"main", commit:"d0ae4199…", pr:"", service:"github-actions",
                  slug:"jxsuite:::jx::::", build:"…", job:"bundle-analysis" }
CODECOV POST  -> 202 Accepted   {"status":"queued","url":"https://storage.googleapis.com/codecov-static-bundles-prod/v1/uploads/…json?X-Amz-…"}
STORAGE PUT   -> 200 OK
```

- Payload is valid v3 (e.g. runtime = 1 asset `runtime.js` 91,431 B, 1 chunk,
  5 modules, gzip/normalized/plugin fields present).
- Codecov returned **no error and no warning** — it queued the upload.
- The commit `d0ae4199` has coverage `state: complete` (98.63%), so Codecov
  fully recognizes it.
- Its bundle report is nonetheless **empty**.

## Ruled out

- ❌ Bad payload / malformed v3 — the same payloads produce a full 15.5MB report
  on PR merge commits.
- ❌ Failed or partial upload — all 4 packages log `Upload successful`; the CLI
  `process.exit(1)`s on failure, and instrumentation confirms POST 202 + PUT 200.
- ❌ Wrong commit SHA on push — push uploads use the real `main` SHA (verified via
  the checkout `git checkout -B main refs/remotes/origin/main` and instrumented
  service params).
- ❌ Commit unknown to Codecov — coverage for the same commits is fully processed.
- ❌ Processing latency — days-old commits remain empty.
- ❌ GitHub Actions debug logging (`ACTIONS_STEP_DEBUG`) — the failure is in the
  Codecov API response (which the CLI discards) and Codecov's async worker;
  neither is visible in runner logs.

## Experiment: add `git_service` (NEGATIVE)

Codecov's official bundler plugin always sends `git_service:"github"` in the
tokenless upload body (`getPreSignedURL.ts`); `metafile-codecov-bundle` omits it.
Hypothesis: without it, Codecov can't attach a _pushed_ commit's bundle to the
branch head.

- Added `params.git_service = "github"` to the upload for commits `ff0664dd` and
  `eee795dd`.
- Both push runs **completed successfully** and were confirmed to contain
  `git_service`.
- Both bundle reports are **still empty (`size 0`)**.

**Conclusion: `git_service` is not the cause.** This was the last client-side
lever; the upload now matches Codecov's own uploader and still yields an empty
default-branch report.

## Conclusion

This is a **Codecov-side processing limitation/bug** for push / default-branch
tokenless v3 bundle uploads. Everything under our control is correct and matches
Codecov's official uploader. Because `main` never gets a baseline, PRs compare
against zero and report +100%, and the branch dashboard stays empty.

## Recommended next steps

1. **Escalate to Codecov** (support ticket / community post) with the repro below.
   This is the primary path — we've proven it's their side.
2. **Optional remaining experiment:** switch from tokenless OIDC to an
   authenticated upload with a `CODECOV_TOKEN` repo secret. Tokenless is designed
   for fork PRs where secrets aren't available; Codecov may not fully process
   tokenless uploads outside a PR context. Caveat: our PR uploads are also
   tokenless and _do_ populate, so this is not guaranteed. The third-party CLI
   supports OIDC only, so the token would need to be wired into a custom upload
   step.
3. **Correctness fix regardless of the above:** on `pull_request` events, upload
   against `github.event.pull_request.head.sha` instead of the merge-ref
   `GITHUB_SHA` (override the `GITHUB_SHA` env on the upload step —
   `getServiceParams` reads it from env). This attaches PR reports to the real
   head commit and is what Codecov's own uploaders do.

## Reproduction (for a Codecov ticket)

> Public repo `jxsuite/jx`. Bundle analysis uploaded via tokenless GitHub OIDC to
> `POST /upload/bundle_analysis/v1` (v3 payload). On a **push to the default
> branch** (`main`), e.g. commit `d0ae419937085f390197ccfb14806fff43a0a5ef`
> (`pr:""`, `branch:"main"`, `git_service:"github"`), the API responds
> `202 {"status":"queued", …}` and the payload PUTs `200 OK`. The commit is fully
> known to Codecov (coverage `state: complete`). **But the resulting bundle
> report is empty** (`branch(name:"main").head.bundleAnalysis.bundleAnalysisReport`
> → `size 0`, `bundles []`). The _same_ uploader on `pull_request` events produces
> a full report on the pre-merge commit (e.g. PR #67 merge SHA
> `ff9c5df85a8ccb747989d538dbdc5c2f9e5fac12` → 15,527,176 bytes). Because the
> default branch never gets a populated report, every PR comparison shows +100%
> and `bundles/main` is empty.

## Appendix A — instrumented upload shim (for future re-use)

Reproduces the CLI's upload but prints what it discards (service params + the
Codecov POST status/headers/body + the storage PUT status). Runs only in GitHub
Actions (OIDC). Written to `packages/<pkg>/codecov-debug.mjs` at runtime and run
with `bun codecov-debug.mjs`; `codecov-debug.mjs` is gitignored. See git history
of `.github/workflows/bundle-analysis.yml` (commits `da1c1087`, `ff0664dd`) for
the full step. Core:

```js
import { readFileSync } from "node:fs";
import { transformMetafile, getServiceParams, fetchOidcToken } from "metafile-codecov-bundle";

const payload = transformMetafile(JSON.parse(readFileSync("metafile.json", "utf8")), {
  bundleName: process.env.BUNDLE_NAME,
  outputDir: "dist",
  bundler: { name: "bun", version: Bun.version },
});
const params = getServiceParams(); // { branch, commit, pr, service, slug, build, job }
// params.git_service = "github";           // experiment (no effect)
const oidc = await fetchOidcToken();
const res = await fetch("https://api.codecov.io/upload/bundle_analysis/v1", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `token ${oidc}` },
  body: JSON.stringify(params),
});
const body = await res.text(); // <- the key visibility the CLI throws away
console.error("CODECOV POST:", res.status, body);
const put = await fetch(JSON.parse(body).url, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.error("STORAGE PUT:", put.status);
```

## Appendix B — useful queries

Codecov bundle report for any commit (returns `size 0` for `main`, full size for
PR merge commits):

```bash
curl -s https://api.codecov.io/graphql/gh \
  -H "Content-Type: application/json" -H "Token-Type: graphql" \
  -d '{"query":"query{owner(username:\"jxsuite\"){repository(name:\"jx\"){... on Repository{commit(id:\"<SHA>\"){bundleAnalysis{bundleAnalysisReport{__typename ... on BundleAnalysisReport{bundleData{size{uncompress}} bundles{name}}}}}}}}}"}'
```

Codecov coverage/commit recognition (proves Codecov knows the commit):

```bash
curl -s "https://api.codecov.io/api/v2/github/jxsuite/repos/jx/commits/<SHA>/"
```
