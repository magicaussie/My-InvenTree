/** Small shared helpers for the designers. */

/** Generate a client-side UUID for a new entity. */
export function newId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback for environments without crypto.randomUUID (older jsdom).
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Convert an `#rrggbb` string into a `[r, g, b]` tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '').trim();
  const value =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  const int = Number.parseInt(value || '000000', 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** Convert an `[r, g, b]` tuple into a `#rrggbb` string. */
export function rgbToHex(rgb: [number, number, number]): string {
  const parts = rgb.map((v) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  );
  return `#${parts.join('')}`;
}

/** Human readable inclusive logical range. */
export function formatRange(start: number, end: number): string {
  return `${start}\u2013${end}`;
}

/** Inclusive pixel count for a range. */
export function rangeCount(start: number, end: number): number {
  return Math.max(0, end - start + 1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
