{
  bun2nix,
  stdenv,
  bun,
  makeWrapper,
  copyDesktopItems,
  chromium,
  lib,
}:
let
  version = (lib.importJSON ../../package.json).version;
in
stdenv.mkDerivation {
  pname = "jx-studio";
  inherit version;

  src = lib.cleanSource ../..;

  nativeBuildInputs = [
    bun2nix.hook
    bun
    makeWrapper
    copyDesktopItems
  ];

  # Offline Bun install cache derived straight from bun.lock via bun.nix.
  # Every dependency hash comes from the lockfile, so there is no aggregate
  # node_modules hash to maintain by hand — regenerate bun.nix with `bun2nix`
  # (the repo's postinstall already does) whenever the lockfile changes.
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../../bun.nix;
  };

  # Use the classic flat node_modules layout. The isolated linker (the bun2nix
  # default) materializes packages behind a per-package store of symlinks that
  # the copied-to-$out output cannot resolve at runtime; hoisted gives real
  # files that survive the `cp -r node_modules` below.
  bunInstallFlags = [ "--linker=hoisted" ];

  # The build never needed dependency lifecycle scripts (the previous FOD ran
  # `bun install --ignore-scripts`), and running them would require network
  # access that the sandbox forbids.
  dontRunLifecycleScripts = true;

  # We ship a runnable Bun workspace, not a single compiled Bun binary, so the
  # build and install steps are driven below rather than by the hook defaults.
  dontUseBunBuild = true;
  dontUseBunCheck = true;

  desktopItems = [ ./jx-studio.desktop ];

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
