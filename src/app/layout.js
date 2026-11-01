import { Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";
import ChunkReloadGuard from "@/shared/components/ChunkReloadGuard";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata = {
  title: "10Router - AI Infrastructure Management",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Pre-paint theme bootstrap (next-themes pattern): resolves the stored
            preference — "system" follows prefers-color-scheme, so Windows
            personalization / macOS appearance / the fnOS browser drive the UI
            with no manual toggle — and sets the class + theme-color BEFORE the
            first paint. Without this every page (login included) rendered in
            whatever the last hard-toggled state was, and dark-on-daylight was
            stuck until a toggle existed. Storage shape = zustand persist
            ({"state":{theme}}); falls back to raw values and "system". */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var raw=null;try{raw=localStorage.getItem('theme')}catch(e){}
var t=null;if(raw){try{var j=JSON.parse(raw);t=(j&&j.state&&j.state.theme)||null}catch(e){t=raw}}
if(t!=='light'&&t!=='dark'&&t!=='brutal')t='system';
var sysDark=!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var dark=t==='dark'||(t==='system'&&sysDark);
var brutal=t==='brutal';
var r=document.documentElement;
if(dark)r.classList.add('dark');else r.classList.remove('dark');
if(brutal)r.classList.add('brutal');else r.classList.remove('brutal');
r.style.colorScheme=dark?'dark':'light';
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute('content',brutal?'#FFF6E5':dark?'#0a0a0a':'#FDFAF6');
}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){document.documentElement.classList.add('fonts-loaded')})}else{document.documentElement.classList.add('fonts-loaded')}`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
        {/* Recovers a blank page after an upgrade (stale chunk map) with one reload. */}
        <ChunkReloadGuard />
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
