export function isBotPollingEnabled(
  configuredValue?: string,
  runtimeValue?: string,
): boolean {
  return (runtimeValue ?? configuredValue) !== "false";
}
