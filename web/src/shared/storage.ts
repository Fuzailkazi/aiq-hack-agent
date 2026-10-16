/** Per-browser conveniences only (e.g. the reviewer's name); every read/write tolerates blocked storage. */
export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: fine, it is only a convenience
  }
}

export function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
