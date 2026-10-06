/** The browser uploads release sources only, never local provisioning or build output. */
export function firmwareSourcePath(path: string): string | null {
  if (path.split('/').some((part) => part === '.' || part === '..' || part === '')) return null;
  const relative = path.replace(/^[^/]+\/(?=(?:src|include)\/|platformio\.ini$)/, '');
  if (/(^|\/)(node_config\.h|tm_test_ca\.h)$/.test(relative)) return null;
  return relative === 'platformio.ini' || /^(src|include)\/[\w./-]+\.(h|hpp|c|cpp|cc)$/.test(relative)
    ? relative : null;
}
