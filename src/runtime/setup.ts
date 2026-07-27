import { parseSetupArgs, runSetupCommand } from "../setup/index.ts";

export async function runSetupCommandIfRequested(rawArgs: string[]): Promise<number | null> {
  const setupOptions = parseSetupArgs(rawArgs);
  if (!setupOptions) return null;
  return runSetupCommand(setupOptions);
}
