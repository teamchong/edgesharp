import OgPlayground from "./OgPlayground";

export default function SharePage() {
  return (
    <main className="max-w-6xl mx-auto px-6 pb-12">
      <header className="mb-8">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">edgesharp-og</h1>
          <span className="text-neutral-400 text-sm">
            Social share images from a meta tag
          </span>
        </div>
        <p className="mt-3 text-neutral-300 max-w-2xl leading-relaxed">
          Point a <code className="text-orange-300">{`<meta property="og:image">`}</code>{" "}
          tag at this Worker. The Worker reads the{" "}
          <code className="text-orange-300">Referer</code> header to know
          which page is being shared, fetches that page&rsquo;s{" "}
          <code className="text-orange-300">{`<head>`}</code>, substitutes
          its meta tags into a template, renders via Satori + Resvg, and
          caches the PNG in R2 forever. No SDK, no build step, no Next.js
          required.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-orange-300 mb-2">
          Try it · render this page as a OG card
        </h2>
        <p className="text-sm text-neutral-400 mb-4 max-w-2xl">
          Live render on a Cloudflare Worker. Pick a template and a
          platform, click Generate. The card uses{" "}
          <em>this very page&rsquo;s</em>{" "}
          <code className="text-orange-300">{`<title>`}</code> and{" "}
          <code className="text-orange-300">{`<meta>`}</code> tags, because
          the browser sends them as the{" "}
          <code className="text-orange-300">Referer</code> when it fetches
          the share Worker.
        </p>
        <OgPlayground />
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          How it stays cheap
        </h2>
        <ul className="text-sm text-neutral-300 space-y-2 max-w-2xl leading-relaxed">
          <li>
            • First request for a unique{" "}
            <code className="text-orange-300">(referer, template)</code>{" "}
            renders and caches to R2. Every subsequent request, Twitter,
            Slack, Discord, real readers, serves from R2 with free egress.
          </li>
          <li>
            • Crawler traffic doesn&rsquo;t multiply costs. Bills are bounded by
            the count of distinct cards, not the count of fetches.
          </li>
          <li>
            • Workers Paid is{" "}
            <a
              href="https://developers.cloudflare.com/workers/platform/pricing/"
              className="text-orange-300 hover:underline"
            >
              $5/month per Cloudflare account
            </a>
            , flat. The same plan covers this and the image-optimization
            Worker on the other tab.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          Customizing the layout
        </h2>
        <p className="text-sm text-neutral-300 max-w-2xl leading-relaxed">
          Templates are HTML files in{" "}
          <code className="text-orange-300">og/src/templates/</code>{" "}
          with{" "}
          <code className="text-orange-300">{`{{key}}`}</code> markers that
          substitute from the source page&rsquo;s extracted{" "}
          <code className="text-orange-300">{`<meta>`}</code> tags. To add
          or change a template, fork the repo, edit the file, push to git,
          Workers Builds redeploys.
        </p>
      </section>
    </main>
  );
}
