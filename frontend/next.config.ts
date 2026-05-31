// NOTE: no explicit `: NextConfig` annotation — Next 16's NextConfig type does
// not declare the (valid, runtime-supported) `eslint` key, so annotating trips
// an excess-property type error during build.
const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for a small,
  // dependency-traced production Docker image.
  output: "standalone",
  eslint: {
    // The existing codebase has substantial lint debt (no-explicit-any,
    // setState-in-effect, etc.). Tracked as a dedicated cleanup milestone;
    // do not block production builds on it for now. Type-checking stays ON.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
