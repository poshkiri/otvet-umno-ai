export function splitLongMessage(text: string, maxLength = 3900): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLength) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
    const splitAt = candidates.find((index) => index >= Math.floor(maxLength * 0.6)) ?? maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function displayName(firstName?: string): string {
  return firstName?.trim() || "друг";
}

export function cleanTelegramText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
