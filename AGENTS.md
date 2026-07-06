<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hosting & deployment

This app is **live in production** at **https://kevin-yin.com/riftelo**, hosted on
**Cloudflare Workers** (via the OpenNext adapter) with a **Neon Postgres** DB.
Read **[DEPLOYMENT.md](DEPLOYMENT.md)** before touching hosting/DB config or
deploying — it explains the architecture and the exact process.

Critical facts:
- **Deploy = run `scripts/deploy.sh` inside WSL.** Native Windows builds/deploys
  DO NOT WORK (OpenNext's bundler breaks on Windows paths). There is no `git push`
  deploy; changes go straight from the working tree to Cloudflare.
- **Don't casually change the Prisma/DB wiring.** `engineType = "client"` +
  always-adapter (`PrismaNeon`) + `.prisma/client` in `serverExternalPackages` +
  `neonConfig.poolQueryViaFetch` are what make Prisma work on Workers. Reverting
  any of them breaks the live site (engine-not-found / wasm-fs-read / random 500s).
- The app is served under the **`/riftelo`** basePath; the root of the domain is
  reserved for other content.
