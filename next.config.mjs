function normalizeBasePath(value) {
  const raw = (value || "").trim();
  if (!raw || raw === "/") {
    return "";
  }

  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

const envBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
const basePath = envBasePath === undefined ? "/tools/audio-clipper" : normalizeBasePath(envBasePath);

const nextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath } : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath
  }
};

export default nextConfig;
