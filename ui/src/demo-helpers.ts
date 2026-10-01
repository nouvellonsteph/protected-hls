export function isPart2Path(pathname: string): boolean {
  return pathname.startsWith("/part-2");
}

export function maskSessionToken(manifest: string): string {
  return manifest.replace(/hdntl=[^&\s",]+/g, "hdntl=<session-token>");
}
