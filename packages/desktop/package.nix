{
  stdenv,
  bun,
  makeWrapper,
  copyDesktopItems,
  chromium,
  lib,
  runCommand,
  fetchurl,
  fetchFromGitHub,
  fetchgit,
}:
let
  # Version comes from the desktop package (the app this derivation actually builds), not the
  # monorepo root — they drift independently.
  version = (lib.importJSON ./package.json).version;

  # Import the bun2nix-generated package set, but wrap each fetcher so we learn
  # which entries are plain registry tarballs (the only ones the offline
  # registry needs to serve). Workspace packages come through `copyPathToStore`
  # and are resolved locally by Bun via the `workspace:` protocol, so we drop
  # them here.
  bunSet = import ../../bun.nix {
    fetchurl = args: {
      drv = fetchurl args;
      serve = true;
    };
    fetchFromGitHub = args: {
      drv = fetchFromGitHub args;
      serve = false;
    };
    fetchgit = args: {
      drv = fetchgit args;
      serve = false;
    };
    copyPathToStore = _path: {
      drv = null;
      serve = false;
    };
  };
  tarballs = lib.filterAttrs (_: e: e.serve) bunSet;

  # Split a "name@version" key (handles scoped names like "@scope/pkg@1.2.3").
  nameOf =
    key:
    let
      segs = lib.splitString "@" key;
    in
    if lib.hasPrefix "@" key then
      "@" + lib.concatStringsSep "@" (lib.init (lib.tail segs))
    else
      lib.concatStringsSep "@" (lib.init segs);
  versionOf = key: lib.last (lib.splitString "@" key);
  unscopedOf = name: lib.last (lib.splitString "/" name);

  # A directory tree mirroring npm registry tarball URLs
  # (<name>/-/<basename>-<version>.tgz), populated from the lockfile-pinned
  # tarballs bun2nix already fetches. No network and no extra hash to maintain:
  # every tarball's integrity comes from bun.lock via bun.nix.
  registryTree = runCommand "jx-bun-registry-tree" { } (
    "mkdir -p $out\n"
    + lib.concatStrings (
      lib.mapAttrsToList (
        key: e:
        let
          name = nameOf key;
          ver = versionOf key;
          dir = "$out/${name}/-";
          dest = "${dir}/${unscopedOf name}-${ver}.tgz";
        in
        ''
          mkdir -p "${dir}"
          cp "${e.drv}" "${dest}"
        ''
      ) tarballs
    )
  );

  registryPort = "48732";
in
stdenv.mkDerivation {
  pname = "jx-studio";
  inherit version;

  src = lib.cleanSource ../..;

  nativeBuildInputs = [
    bun
    makeWrapper
    copyDesktopItems
  ];

  dontConfigure = true;

  desktopItems = [ ./jx-studio.desktop ];

  # `bun install` re-resolves a workspace's directly declared dependencies
  # against the registry even with a full cache and `--frozen-lockfile`
  # (it sees a phantom "updated N dependencies" diff for the workspace
  # packages). That needs the network, which the sandbox forbids. So instead of
  # bun2nix's offline cache we stand up a throwaway registry on loopback that
  # serves lockfile-derived manifests plus the pre-fetched tarballs, and point
  # Bun at it. See scripts/registry-shim.ts for the why and how.
  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR"

    bun ${./scripts/registry-shim.ts} bun.lock ${registryTree} ${registryPort} &
    shimPid=$!
    trap 'kill $shimPid 2>/dev/null || true' EXIT

    # Wait for the shim to accept connections before installing.
    for _ in $(seq 1 100); do
      if bun -e 'await fetch("http://localhost:${registryPort}/lit-html").then(() => process.exit(0)).catch(() => process.exit(1))' 2>/dev/null; then
        break
      fi
      sleep 0.2
    done

    bun install \
      --registry "http://localhost:${registryPort}" \
      --frozen-lockfile \
      --linker=hoisted \
      --ignore-scripts

    kill $shimPid 2>/dev/null || true
    trap - EXIT

    # studio's build bundles monaco-editor's web workers via the literal path
    # ./node_modules/monaco-editor. The hoisted linker keeps monaco at the repo
    # root (no per-package node_modules), so expose it where the script looks.
    # Removed again before install — the runtime resolves deps from the root.
    mkdir -p packages/studio/node_modules
    ln -srf node_modules/monaco-editor packages/studio/node_modules/monaco-editor

    bun run build
    bun run --cwd packages/desktop scripts/pre-build-rpc.ts

    rm -rf packages/studio/node_modules

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/jx-studio $out/bin

    # Preserve workspace structure so Bun's symlink-based resolution works
    cp -r node_modules $out/lib/jx-studio/
    cp -r packages $out/lib/jx-studio/packages

    # bun links every workspace member into node_modules, including ones the
    # desktop app doesn't ship (examples, sites/*). We only copy `packages`, so
    # prune the now-dangling workspace symlinks rather than haul in dev-only code.
    find $out/lib/jx-studio/node_modules -xtype l -delete

    makeWrapper ${bun}/bin/bun $out/bin/jx-studio \
      --add-flags "run $out/lib/jx-studio/packages/desktop/src/chromium/index.ts" \
      --set CHROMIUM_BIN "${chromium}/bin/chromium" \
      --set JX_STUDIO_ASSETS "$out/lib/jx-studio/packages/desktop/assets/studio"

    install -Dm644 packages/desktop/icon.png $out/share/icons/hicolor/512x512/apps/jx-studio.png
    install -Dm644 branding/jx_flattened.svg $out/share/icons/hicolor/scalable/apps/jx-studio.svg

    runHook postInstall
  '';

  meta = {
    description = "Jx Studio — visual JSON component editor";
    homepage = "https://jxsuite.com";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
