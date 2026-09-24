import { clearInheritedPowerShellModulePath } from "../src/windows-powershell-environment.js";

process.env.NODE_ENV = "test";
if (process.platform === "win32") clearInheritedPowerShellModulePath();
