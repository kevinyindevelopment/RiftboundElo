import type { MetadataRoute } from "next";

/**
 * Crawl policy — this exists for COST reasons, not SEO.
 *
 * The site exposes roughly 51k crawlable URLs (33k players + 17.9k visible
 * events). Neon bills compute by awake-time and suspends after 5 minutes idle,
 * so a bot walking that space keeps the database awake for as long as the crawl
 * runs. Player and event pages are still allowed — they are the point of the
 * site — but the cache TTLs plus a crawl delay keep the cost bounded.
 *
 * `/search` is disallowed outright: its query space is unbounded, every distinct
 * term is a fresh cache key and a fresh set of sequential scans, and search
 * result pages have no business being indexed anyway. Humans are unaffected.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/search"],
        // Respected by Bing/Yandex and several others. Googlebot ignores it and
        // is rate-limited via Search Console instead, but it meaningfully caps
        // the long tail of less well-behaved crawlers.
        crawlDelay: 10,
      },
    ],
  };
}
