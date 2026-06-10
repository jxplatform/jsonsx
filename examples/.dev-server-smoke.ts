import { createDevServer } from "@jxsuite/server";
await createDevServer({ root: process.cwd(), port: 5199, watch: false, studio: true });
console.log("ready on", 5199);
