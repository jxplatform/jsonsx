#!/usr/bin/env bash
# Idempotent re-application of tracked-file changes for the coverage-enforcement work.
cd /home/batonac/Development/jx
# 1. .gitignore: coverage/ entry
grep -q "^coverage/" .gitignore || sed -i 's|^dist/|coverage/\ndist/|' .gitignore
# 2. root package.json: test:coverage:workspaces script
grep -q "test:coverage:workspaces" package.json || sed -i 's|"test:coverage": "bun test --isolate --coverage",|"test:coverage": "bun test --isolate --coverage",\n    "test:coverage:workspaces": "bun run --workspaces test:coverage",|' package.json
# 3. create package.json: scripts block
grep -q '"scripts"' packages/create/package.json || sed -i 's|"type": "module",|"type": "module",\n  "scripts": {\n    "test": "bun test --isolate",\n    "test:coverage": "bun test --isolate --coverage"\n  },|' packages/create/package.json
# 4. studio bunfig.toml: full rewrite
cat > packages/studio/bunfig.toml <<'TOML'
[test]
coverageReporter = ["text", "lcov"]
coverageSkipTestFiles = true
coveragePathIgnorePatterns = [
  "**/tests/**",
  "./result/**",
  "../compiler/**",
  "../create/**",
  "../desktop/**",
  "../parser/**",
  "../runtime/**",
  "../schema/**",
  "../server/**",
]
coverageThreshold = { lines = 0.02, functions = 0.0 }
TOML
# 5. image-optimizer sharp types
f=packages/compiler/src/site/image-optimizer.ts
grep -q "SharpNS" $f || {
  sed -i 's|import type { FormatEnum } from "sharp";|// Sharp 0.35 only has a default export (function merged with a types namespace).\nimport type SharpNS from "sharp";|' $f
  sed -i 's|type SharpModule = typeof import("sharp");|type SharpModule = typeof SharpNS;|' $f
  sed -i 's|format as keyof FormatEnum|format as keyof SharpNS.FormatEnum|' $f
  sed -i '/oxlint-disable-next-line typescript\/consistent-type-imports -- sharp is an optional native dep/d' $f
}
# 6. desktop package.json: happy-dom devDependency
grep -q "happy-dom" packages/desktop/package.json || sed -i '/"devDependencies": {/a\    "@happy-dom/global-registrator": "^20.10.2",' packages/desktop/package.json
echo "restored. status:"; git status --short | grep -v "^??"
# 7. icons.ts: remove dead _R/_S helpers (unused, block 100% coverage)
if grep -q "_R = " packages/studio/src/ui/icons.ts; then
python3 - <<'PYEOF'
import re
p = "packages/studio/src/ui/icons.ts"
s = open(p).read()
s = re.sub(r'import \{ html \} from "lit";\nimport type \{ TemplateResult \} from "lit";\n\n// Helper for custom filled-rect icons.*?</svg>`;\n\n(export const icons)', r'import { html } from "lit";\n\n\1', s, flags=re.S)
open(p, "w").write(s)
PYEOF
fi
