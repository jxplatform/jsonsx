import { readFileSync } from "node:fs";
import { transformMetafile, getServiceParams, fetchOidcToken } from "metafile-codecov-bundle";
const NAME = process.env.BUNDLE_NAME;
const banner = (s) => console.error(`\n===== [bundle-debug:${NAME}] ${s} =====`);
const meta = JSON.parse(readFileSync("metafile.json", "utf8"));
const payload = transformMetafile(meta, {
  bundleName: NAME,
  outputDir: "dist",
  bundler: { name: "bun", version: Bun.version },
});
const totalBytes = payload.assets.reduce((n, a) => n + a.size, 0);
banner(`payload: bundleName=${payload.bundleName} assets=${payload.assets.length} chunks=${payload.chunks.length} totalBytes=${totalBytes}`);
const params = getServiceParams();
banner("SERVICE PARAMS sent to Codecov (branch/commit/pr are the key fields)");
console.error("GITHUB_EVENT_NAME =", process.env.GITHUB_EVENT_NAME);
console.error(JSON.stringify(params, null, 2));
const oidc = await fetchOidcToken();
banner(`OIDC token acquired (length ${oidc.length})`);
const res = await fetch("https://api.codecov.io/upload/bundle_analysis/v1", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `token ${oidc}` },
  body: JSON.stringify(params),
});
const body = await res.text();
banner(`CODECOV POST -> ${res.status} ${res.statusText}`);
console.error("response headers:", JSON.stringify(Object.fromEntries(res.headers), null, 2));
console.error("response body:", body);
let putUrl;
try { putUrl = JSON.parse(body).url; } catch { }
if (!putUrl) { banner("NO presigned url in response body -- stopping before PUT"); process.exit(1); }
const put = await fetch(putUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const putBody = await put.text();
banner(`STORAGE PUT -> ${put.status} ${put.statusText}`);
if (putBody) console.error("PUT body (first 500 chars):", putBody.slice(0, 500));
banner("done");