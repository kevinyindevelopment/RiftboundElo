import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Served under kevin-yin.com/riftelo — a sub-path of the domain (the root is
  // reserved for other content). next/link + next/router prefix automatically;
  // raw asset/fetch paths must include the prefix themselves. Inlined at build
  // time, so a rebuild is required to change it.
  basePath: "/riftelo",
  // Keep Prisma out of Next's bundle so OpenNext can resolve it with the
  // "workerd" export condition (wasm compiler imported as a module). `.prisma/
  // client` is the underlying generated package where the wasm loader lives —
  // externalizing ONLY `@prisma/client` isn't enough; without `.prisma/client`
  // Next inlines the Node loader and the Worker fs-reads the wasm and 500s.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "prisma"],
  // Pin the workspace root to THIS project. A stray package-lock.json in a
  // parent dir (e.g. the home folder) otherwise makes Next infer the wrong
  // root, which breaks dev client-side navigation / HMR.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
