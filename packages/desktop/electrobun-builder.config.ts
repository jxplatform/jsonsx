import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default {
  name: "Jx Studio",
  version: pkg.version,
  author: "jxsuite",
  windows: {
    icon: "icon.png",
    productId: "com.jxsuite.jx-studio",
    installDir: "Jx Studio",
  },
};
