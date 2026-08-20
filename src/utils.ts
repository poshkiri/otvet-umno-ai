export function splitLongMessage(text: string, maxLength = 3900): string[] {
  const normalized = wellFormedText(text).trim();
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

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function cleanTelegramText(text: string): string {
  return wellFormedText(text)
    .replace(/\*\*/g, "")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function wellFormedText(text: string): string {
  return Array.from(text, (character) => {
    if (character.length > 1) return character;
    const code = character.charCodeAt(0);
    return code >= 0xD800 && code <= 0xDFFF ? "�" : character;
  }).join("");
}
