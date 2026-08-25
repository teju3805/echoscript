import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Echoscript — audio notes, transcribed and summarised',
  description:
    'Upload a recording, get a timestamped transcript from Gnani Prisma v2.5 and an LLM summary you can actually use.',
};

function Wordmark() {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <span className="relative flex h-6 items-end gap-[3px]" aria-hidden>
        {[9, 16, 22, 13, 7].map((h, i) => (
          <span
            key={i}
            className="w-[2.5px] rounded-full bg-ember-500 transition-all duration-300 group-hover:bg-ember-400"
            style={{ height: h }}
          />
        ))}
      </span>
      <span className="font-mono text-[13px] font-medium uppercase tracking-[0.2em] text-bone-100">
        Echoscript
      </span>
    </Link>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <div className="relative z-10 flex min-h-screen flex-col">
          <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-md">
            <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
              <Wordmark />
              <nav className="flex items-center gap-1 text-sm">
                <Link
                  href="/"
                  className="rounded-full px-3.5 py-1.5 text-bone-400 transition-colors hover:bg-white/[0.05] hover:text-bone-100"
                >
                  Studio
                </Link>
                <Link
                  href="/architecture"
                  className="rounded-full px-3.5 py-1.5 text-bone-400 transition-colors hover:bg-white/[0.05] hover:text-bone-100"
                >
                  Architecture
                </Link>
              </nav>
            </div>
          </header>

          <main className="flex-1">{children}</main>

          <footer className="border-t border-white/[0.06] py-8">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 font-mono text-[11px] tracking-wide text-bone-600 sm:flex-row sm:items-center sm:justify-between">
              <span>Speech recognition by Gnani Prisma v2.5 (Vachana STT)</span>
              <span>Built for the Audio Notes Platform assignment</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
