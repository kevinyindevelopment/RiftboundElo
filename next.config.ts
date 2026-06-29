import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's generated client uses Node APIs; keep it out of the bundle.
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
