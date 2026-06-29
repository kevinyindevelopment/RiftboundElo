import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Riftbound Elo",
  description: "Personal Riftbound competitive rankings, players, decks and events.",
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
        <header className="border-b border-border bg-surface/70 backdrop-blur sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-6">
            <Link href="/" className="font-bold tracking-tight text-lg">
              <span className="text-accent">Rift</span>Elo
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-3 py-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto text-xs text-muted hidden sm:block">
              personal Riftbound ladder
            </span>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
        <footer className="border-t border-border text-xs text-muted">
          <div className="mx-auto max-w-6xl px-4 py-4">
            Personal-use Riftbound Elo tracker. Data sourced from carde.io / UVS for
            private use — not affiliated with Riot Games, UVS Games, or carde.io.
          </div>
        </footer>
      </body>
    </html>
  );
}
