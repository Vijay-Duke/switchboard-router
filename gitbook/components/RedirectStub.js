const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * Static-export stand-in for an HTTP redirect: meta refresh for browsers,
 * canonical link for crawlers, plain anchor for anyone with JS/meta disabled.
 * @param {{ href: string }} props absolute path, basePath is prepended here
 */
export default function RedirectStub({ href }) {
  const to = `${basePath}${href}`;
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${to}`} />
      <link rel="canonical" href={to} />
      <main style={{ padding: "4rem", fontFamily: "system-ui, sans-serif" }}>
        <p>This page has moved.</p>
        <p>
          <a href={to}>Continue to {to}</a>
        </p>
      </main>
    </>
  );
}
