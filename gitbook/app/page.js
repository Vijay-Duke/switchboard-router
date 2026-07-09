import { DEFAULT_LANG } from "@/constants/languages";

// Must include basePath for GitHub project pages (e.g. /switchboard-router).
// Raw absolute "/en/" sends users to vijay-duke.github.io/en/ → 404.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const TARGET = `${BASE}/${DEFAULT_LANG}/`.replace(/\/{2,}/g, "/");

export const metadata = {
  title: "Switchboard Docs",
  description: "Smart AI model router — maximize subscriptions, minimize costs",
};

export default function HomePage() {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.location.replace(${JSON.stringify(TARGET)});`,
        }}
      />
      <meta httpEquiv="refresh" content={`0;url=${TARGET}`} />
      <p style={{ padding: "2rem", textAlign: "center" }}>
        Redirecting to <a href={TARGET}>{TARGET}</a>…
      </p>
    </>
  );
}
