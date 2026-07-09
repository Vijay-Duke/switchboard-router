// @ts-check
export default function manifest() {
  return {
    name: "Switchboard — Intelligent Model Routing",
    short_name: "Switchboard",
    description:
      "Route every request to the right model. One OpenAI-compatible endpoint with visible routing and self-improving combos.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icons/icon-192.svg",
        sizes: "192x192",
        type: "image/svg+xml",
      },
      {
        src: "/icons/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
      },
      {
        src: "/icons/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
