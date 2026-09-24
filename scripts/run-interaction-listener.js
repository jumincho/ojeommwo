import {
  installManagedInteractionLog,
  redactManagedLogText
} from "./managed-interaction-log.js";

const managedServerLog = process.env.OJEOMMWO_MANAGED_INTERACTION_LOG === "1";
let managedLog = null;

try {
  if (managedServerLog) managedLog = installManagedInteractionLog();
  // Managed server logging must own its FD before application imports can emit
  // diagnostics. Direct and local-emergency runs keep their normal stdio.
  const [{ assertRuntimeConfig }, { runInteractionListener }] = await Promise.all([
    import("../src/config.js"),
    import("../src/interaction-listener.js")
  ]);
  assertRuntimeConfig({ requireBotToken: true });
  await runInteractionListener();
} catch (error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  try {
    console.error(`${new Date().toISOString()} [interaction-listener] fatal: ${redactManagedLogText(detail)}`);
  } catch {
    // A failed managed log is fatal; do not continue an unobservable listener.
  }
  process.exitCode = 1;
} finally {
  managedLog?.close();
}
