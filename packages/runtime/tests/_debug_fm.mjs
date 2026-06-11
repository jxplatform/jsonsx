import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkParseFrontmatter from "remark-parse-frontmatter";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { readFileSync } from "node:fs";

const src = readFileSync("examples/markdown/content/posts/getting-started.md", "utf8");

// Full pipeline
const result = await unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkParseFrontmatter)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true })
  .process(src);

console.log("result.data:", JSON.stringify(result.data, null, 2));
console.log("html snippet:", String(result).slice(0, 200));
