import { registerPlatform } from "@jxsuite/studio/platform";
import { createDesktopPlatform } from "./platform";

registerPlatform(createDesktopPlatform());
