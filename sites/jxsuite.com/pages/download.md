---
title: "Download Jx Studio — the visual IDE for the web."
$head:
  - tagName: meta
    attributes:
      name: description
      content: "Download Jx Studio for macOS, Windows, or Linux. A free, open-source visual IDE that builds real websites and saves everything as plain files. Or install via the CLI."
  - tagName: meta
    attributes:
      property: "og:title"
      content: "Download Jx Studio"
  - tagName: meta
    attributes:
      property: "og:description"
      content: "Free, open-source desktop app for macOS, Windows, and Linux. Or install via the CLI."
$elements:
  - "$ref": "../components/cta-button.json"
  - "$ref": "../components/check-item.json"
  - "$ref": "../components/section-label.json"
---

::::::hero{style.padding="clamp(5rem, 10vw, 8rem) clamp(1rem, 3vw, 2rem) clamp(3rem, 6vw, 4rem)" style.textAlign="center" style.background="radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59, 130, 246, 0.12), transparent)"}
:::::div{style.maxWidth="720px" style.margin="0 auto"}
::section-label{props.text="Download"}

:::h1{style.fontSize="clamp(2.25rem, 5vw, 3.75rem)" style.fontWeight="700" style.letterSpacing="-0.04em" style.lineHeight="1.1" style.margin="0 0 1.5rem" style.color="var(--color-text-primary)"}
Get Jx Studio.
:::

:::p{style.fontSize="clamp(1.0625rem, 2vw, 1.25rem)" style.color="var(--color-text-secondary)" style.lineHeight="1.7" style.margin="0 auto" style.maxWidth="600px"}
A free, open-source visual IDE that builds real websites and saves everything as plain files you keep forever. Download the desktop app, or install via the terminal.
:::
:::::
::::::

::::::installers{style.padding="clamp(2rem, 5vw, 4rem) clamp(1rem, 3vw, 2rem)"}
:::::div{style.maxWidth="var(--max-width)" style.margin="0 auto" style.display="grid" style.gridTemplateColumns="repeat(auto-fit, minmax(min(280px, 100%), 1fr))" style.gap="1rem"}

::::div{style.display="flex" style.flexDirection="column" style.gap="1rem" style.padding="2rem" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.textAlign="center"}
:::div{style.fontSize="2rem"}
🍎
:::

:::h2{style.fontSize="1.25rem" style.fontWeight="700" style.margin="0"}
macOS
:::

:::p{style.fontSize="0.875rem" style.color="var(--color-text-secondary)" style.margin="0" style.lineHeight="1.6"}
Signed &amp; notarized. Apple Silicon, macOS 12 or later.
:::

::cta-button{props.href="https://github.com/jxsuite/jx/releases/latest/download/macos-arm64-JxStudio.dmg" props.label="Apple Silicon" props.variant="primary" props.newTab="true"}
::::

::::div{style.display="flex" style.flexDirection="column" style.gap="1rem" style.padding="2rem" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.textAlign="center"}
:::div{style.fontSize="2rem"}
🪟
:::

:::h2{style.fontSize="1.25rem" style.fontWeight="700" style.margin="0"}
Windows
:::

:::p{style.fontSize="0.875rem" style.color="var(--color-text-secondary)" style.margin="0" style.lineHeight="1.6"}
Unsigned installer — Windows SmartScreen will warn on first run. Windows 10 or later, x64.
:::

::cta-button{props.href="https://github.com/jxsuite/jx/releases/latest/download/JxStudio.msi" props.label="Download .msi" props.variant="primary" props.newTab="true"}
::::

::::div{style.display="flex" style.flexDirection="column" style.gap="1rem" style.padding="2rem" style.borderRadius="var(--radius-lg)" style.border="1px solid var(--color-border)" style.backgroundColor="var(--color-bg-surface)" style.textAlign="center"}
:::div{style.fontSize="2rem"}
🐧
:::

:::h2{style.fontSize="1.25rem" style.fontWeight="700" style.margin="0"}
Linux
:::

:::p{style.fontSize="0.875rem" style.color="var(--color-text-secondary)" style.margin="0" style.lineHeight="1.6"}
Portable archive. Runs on most modern distros.
:::

::cta-button{props.href="https://github.com/jxsuite/jx/releases/latest/download/linux-x64-JxStudio-Setup.tar.gz" props.label="x64" props.variant="primary" props.newTab="true"}

::cta-button{props.href="https://github.com/jxsuite/jx/releases/latest/download/linux-arm64-JxStudio-Setup.tar.gz" props.label="ARM64" props.variant="secondary" props.newTab="true"}
::::

:::::

:::div{style.maxWidth="var(--max-width)" style.margin="1.5rem auto 0" style.textAlign="center" style.fontSize="0.8125rem" style.color="var(--color-text-muted)"}
Looking for a specific version, checksums, or the full list of builds? See [all releases on GitHub](https://github.com/jxsuite/jx/releases/latest).
:::

:::div{style.maxWidth="var(--max-width)" style.margin="0.75rem auto 0" style.textAlign="center" style.fontSize="0.8125rem" style.color="var(--color-text-muted)"}
On NixOS the same app is built from source — `nix run github:jxsuite/jx/release`. See [Install](/docs/start/install).
:::
::::::

::::::cli{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem)" style.borderTop="1px solid var(--color-border)"}
:::::div{style.maxWidth="720px" style.margin="0 auto" style.textAlign="center"}
::section-label{props.text="For developers"}

:::h2{style.fontSize="clamp(1.5rem, 3vw, 2.25rem)" style.fontWeight="700" style.letterSpacing="-0.03em" style.margin="0 0 1rem"}
Rather work from the terminal?
:::

:::p{style.color="var(--color-text-secondary)" style.fontSize="1.0625rem" style.lineHeight="1.7" style.margin="0 auto 2rem" style.maxWidth="560px"}
Scaffold a project and run it locally with live reload from your own machine. For the visual editor, use the Studio desktop app above.
:::

::::div{style.backgroundColor="var(--color-bg-surface)" style.border="1px solid var(--color-border)" style.borderRadius="var(--radius)" style.padding="1.25rem 1.5rem" style.fontFamily="var(--font-mono)" style.fontSize="0.875rem" style.color="var(--color-text-secondary)" style.textAlign="left" style.lineHeight="2" style.maxWidth="480px" style.margin="0 auto 2rem"}
:::span{style.color="var(--color-text-muted)"}
$
:::
 bun create @jxsuite my-site\
:span[$]{style.color="var(--color-text-muted)"} cd my-site &amp;&amp; bun run dev
::::

::cta-button{props.href="/docs/start/first-project" props.label="Read the quickstart" props.variant="secondary"}
:::::
::::::
