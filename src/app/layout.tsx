import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { SearchBar } from "@/components/search-bar";
import { MobileNav } from "@/components/mobile-nav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Riftbound Elo",
  description: "Riftbound competitive rankings, players, decks, and events.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const NAV = [
  { href: "/", label: "Home" },
  { href: "/rankings", label: "Rankings" },
  { href: "/players", label: "Players" },
  { href: "/events", label: "Events" },
  { href: "/stores", label: "Stores" },
  { href: "/decks", label: "Metagame" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-background/75 backdrop-blur-xl">
          <div className="mx-auto max-w-[1180px] px-4 sm:px-6 h-15 flex items-center gap-3 sm:gap-6">
            <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight text-lg shrink-0">
              <svg viewBox="0 0 32 32" width="19" height="19" aria-hidden="true" className="text-accent">
                <polygon
                  points="16,2 28,9 28,23 16,30 4,23 4,9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.1"
                />
              </svg>
              <span className="text-accent">Rift</span>Elo
            </Link>
            <nav className="hidden md:flex items-center gap-0.5 text-[13px]">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-3.5 py-1.5 rounded-full text-muted hover:text-foreground hover:bg-surface-2/70 transition-colors"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <SearchBar className="ml-auto w-36 sm:w-64" />
            <MobileNav items={NAV} />
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-[1180px] px-4 sm:px-6 py-8 sm:py-10">{children}</main>
        <footer className="mt-8 text-xs text-muted">
          <div className="rule-irid mx-auto max-w-[1180px] opacity-30" />
          <div className="mx-auto max-w-[1180px] px-4 sm:px-6 py-6 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
            <span>
              Unofficial Riftbound competitive analytics. Not affiliated with,
              endorsed by, or sponsored by Riot Games, UVS Games, or carde.io.
            </span>
            <span className="shrink-0 text-muted/70">Glicko-2 &middot; updated every 6h</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
