{
  bun2nix,
  stdenv,
  bun,
  makeWrapper,
  copyDesktopItems,
  chromium,
  lib,
  cacert,
}:
let
  version = (lib.importJSON ../../package.json).version;

  # Fixed-output derivation for node_modules — has network access to fetch
  # npm manifests that bun2nix doesn't cache yet.
  # See: https://github.com/nix-community/bun2nix/issues/77
  nodeModules = stdenv.mkDerivation {
    pname = "jx-studio-node-modules";
    inherit version;
    src = lib.cleanSource ../..;

    nativeBuildInputs = [ bun cacert ];

    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      export HOME="$TMPDIR"
      bun install --frozen-lockfile --ignore-scripts
    '';

    installPhase = ''
      mkdir -p $out
      # Copy node_modules preserving symlinks (Bun's resolution depends on them)
      cp -r node_modules $out/node_modules
      find packages -name node_modules -type d | while read -r nm; do
        mkdir -p "$out/$(dirname "$nm")"
        cp -r "$nm" "$out/$nm"
      done
      # Remove dangling symlinks that reference the build sandbox
      find $out -type l ! -exec test -e {} \; -delete 2>/dev/null || true
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-1L47X5hdJ+G/bQwYKUbAJzKN87+9nfIn6pTMTKFY0O4=";
  };
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

  desktopItems = [ ./jx-studio.desktop ];

  configurePhase = ''
    # Restore node_modules from the FOD
    cp -r "${nodeModules}"/node_modules .
    chmod -R u+w node_modules
    # Restore workspace-scoped node_modules
    find "${nodeModules}/packages" -name node_modules -type d 2>/dev/null | while read -r nm; do
      rel="''${nm#${nodeModules}/}"
      if [ ! -d "$rel" ]; then
        mkdir -p "$(dirname "$rel")"
        cp -r "$nm" "$rel"
        chmod -R u+w "$rel"
      fi
    done
  '';

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR"
    bun run build
    bun run --cwd packages/desktop scripts/pre-build-rpc.ts

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/jx-studio $out/bin

    # Preserve workspace structure so Bun's symlink-based resolution works
    cp -r node_modules $out/lib/jx-studio/
    cp -r packages $out/lib/jx-studio/packages

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
