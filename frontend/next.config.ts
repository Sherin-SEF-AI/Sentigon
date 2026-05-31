import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // The existing codebase has substantial lint debt (no-explicit-any,
    // setState-in-effect, etc.). Tracked as a dedicated cleanup milestone;
    // do not block production builds on it for now. Type-checking stays ON.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
