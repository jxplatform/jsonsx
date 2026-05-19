import { registerPlatform } from "@jxsuite/studio/platform.js";
import { createDesktopPlatform } from "./platform";

registerPlatform(createDesktopPlatform());
