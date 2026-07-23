import { createDevServer } from "@jxsuite/server";

const ROOT = "/home/batonac/Development/jx";
const server = await createDevServer({ port: 0, root: ROOT, watch: false });
const base = `http://127.0.0.1:${server.port}`;

const activate = await fetch(`${base}/__studio/activate`, {
  body: JSON.stringify({ root: "sites/jxsuite.com" }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
const activateBody = await activate.text();
console.log("activate:", activate.status, activateBody.slice(0, 120));

for (const path of [
  "/content/docs/images/hero.png",
  "/content/docs/images/nope.png",
  "/content/docs/../../packages/schema/package.json",
  "/content/docs/start/first-collection.md",
]) {
  const res = await fetch(base + path);
  const body = await res.arrayBuffer();
  console.log(path, "→", res.status, `${body.byteLength} bytes`);
}

server.stop(true);
