{
  stdenv,
  bun,
  makeWrapper,
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
  # `bun install` only ever downloads the optional native sidecars whose `os`
  # and `cpu` match the host, but bun.lock pins every platform npm publishes —
  # Windows and macOS esbuild/sharp/oxlint/tsgo binaries included. Served
  # unconditionally they become build inputs of `registryTree`, so `nix build`
  # fetches hundreds of megabytes it will never hand to Bun. Filter on the same
  # two fields Bun filters on; libc deliberately is not one of them, which is
  # why the `linuxmusl` sharp builds stay (Bun installs those on glibc too).
  #
  # A package name that mentions no platform at all is always kept, and a
  # wrongly-dropped tarball fails loudly — the shim answers its fetch with a
  # 404 and `bun install` aborts — so the filter can never silently ship a
  # half-installed tree.
  osTokens = [
    "aix"
    "android"
    "darwin"
    "freebsd"
    "linux"
    "linuxmusl"
    "netbsd"
    "openbsd"
    "openharmony"
    "sunos"
    "webcontainers"
    "win32"
  ];
  cpuTokens = [
    "arm"
    "arm64"
    "ia32"
    "loong64"
    "mips64el"
    "ppc64"
    "riscv64"
    "s390x"
    "wasm32"
    "x64"
  ];
  hostOs = if stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  hostCpu =
    let
      cpu = stdenv.hostPlatform.parsed.cpu.name;
    in
    {
      x86_64 = "x64";
      aarch64 = "arm64";
      armv7l = "arm";
      i686 = "ia32";
    }
    .${cpu} or cpu;
  forThisHost =
    key:
    let
      toks = lib.splitString "-" (unscopedOf (nameOf key));
      os = lib.intersectLists toks osTokens;
      cpu = lib.intersectLists toks cpuTokens;
    in
    (os == [ ] || lib.elem hostOs os || lib.elem "${hostOs}musl" os)
    && (cpu == [ ] || lib.elem hostCpu cpu);

  tarballs = lib.filterAttrs (key: e: e.serve && forThisHost key) bunSet;

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
  ];

  dontConfigure = true;

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

    # `extensions/` is RUNTIME, not dev-only. @jxsuite/{parser,auth,connector,search}
    # live there and node_modules/@jxsuite/parser is a symlink to
    # ../../extensions/parser; `packages/desktop` declares it as a dependency.
    # Copying only `packages` left that link dangling, the prune below then
    # deleted it, and the schema loader — which by design refuses to read a
    # first-party @jxsuite/* schema from the PROJECT's node_modules — had
    # nowhere left to read the parser's project fragment from. Every project
    # declaring any extension lost its per-project Monaco schemas with a stack
    # trace in the log.
    cp -r extensions $out/lib/jx-studio/extensions

    # bun links every workspace member into node_modules, including ones the
    # desktop app doesn't ship (examples, sites/*). We copy `packages` and
    # `extensions`, so prune what is left dangling rather than haul in dev-only
    # code. Anything a shipped package DEPENDS ON must be copied above first:
    # this line deletes, it does not warn.
    find $out/lib/jx-studio/node_modules -xtype l -delete

    makeWrapper ${bun}/bin/bun $out/bin/jx-studio \
      --add-flags "run $out/lib/jx-studio/packages/desktop/src/chromium/index.ts" \
      --set CHROMIUM_BIN "${chromium}/bin/chromium" \
      --set JX_STUDIO_ASSETS "$out/lib/jx-studio/packages/desktop/assets/studio"

    # Installed by hand rather than through `desktopItems`, because that hook takes the STORE PATH's
    # basename — so the entry shipped as `<hash>-jx-studio.desktop`, an id that changed with every
    # rebuild and matched no window. A launcher reads the file and shows Name + Icon either way,
    # which is why the icon appeared there and nowhere else; anything resolving a window to an entry
    # by id had nothing stable to find.
    install -Dm644 packages/desktop/jx-studio.desktop $out/share/applications/jx-studio.desktop

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
