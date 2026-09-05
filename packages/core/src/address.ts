/** Parse `<owner>.<name>` addresses used for holes (`bb_a.a7`) and terminals (`sen66.SDA`). */
export interface ParsedAddress {
  owner: string;
  name: string;
}

export function parseAddress(addr: string): ParsedAddress | null {
  const i = addr.indexOf('.');
  if (i <= 0 || i === addr.length - 1) return null;
  return { owner: addr.slice(0, i), name: addr.slice(i + 1) };
}

export function holeAddress(boardId: string, hole: string): string {
  return `${boardId}.${hole}`;
}

export function terminalAddress(componentId: string, pin: string): string {
  return `${componentId}.${pin}`;
}
