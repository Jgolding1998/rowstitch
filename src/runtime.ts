/** Supported stable LTS lines; keep the CLI and SDK on the same policy. */
export const NODE_REQUIREMENT = 'Node 24.22.2+ or Node 26.13.0+ within those LTS release lines';

export function supportedNode(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger)
    && (major === 24 && (minor > 22 || minor === 22 && patch >= 2)
      || major === 26 && minor >= 13);
}
