import { globSync } from "glob";
import { join } from "node:path";

const dir = join("examples", "markdown", "content", "posts");
console.log("Pattern:", join(dir, "*.md"));
const results = globSync(join(dir, "*.md"));
console.log("Found:", results.length, results);
const fwd = `${dir.split("\\").join("/")}/*.md`;
console.log("Forward pattern:", fwd);
const results2 = globSync(fwd);
console.log("Found2:", results2.length, results2);
