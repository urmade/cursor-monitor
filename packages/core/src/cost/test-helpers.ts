/** Uppercase alphanumeric project key for integration tests. */
export function testProjectKey(prefix = 'P4'): string {
  const suffix = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0');
  return `${prefix}${suffix}${rand}`.replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
}
