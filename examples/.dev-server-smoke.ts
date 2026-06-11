import { createDevServer } from "@jxsuite/server";

await createDevServer({ port: 5199, root: process.cwd(), studio: true, watch: false });
console.log("ready on", 5199);
