function normalizeBasePath(value: string | null | undefined): string {
  const raw = (value || "").trim();
  if (!raw || raw === "/") {
    return "";
  }

  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

const configuredBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

export function getBasePath(): string {
  return configuredBasePath;
}

export function withBasePath(pathname: string): string {
  if (!pathname) {
    return configuredBasePath || "/";
  }

  if (/^https?:\/\//i.test(pathname)) {
    return pathname;
  }

  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (configuredBasePath && normalizedPath.startsWith(`${configuredBasePath}/`)) {
    return normalizedPath;
  }
  if (configuredBasePath && normalizedPath === configuredBasePath) {
    return normalizedPath;
  }

  return `${configuredBasePath}${normalizedPath}`;
}

