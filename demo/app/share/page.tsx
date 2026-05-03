import SharePlayground from "./SharePlayground";

export default function SharePage() {
  return (
    <main className="max-w-6xl mx-auto px-6 pb-12">
      <header className="mb-8">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">edgesharp-share</h1>
          <span className="text-neutral-400 text-sm">
            Social share images from a meta tag
          </span>
        </div>
        <p className="mt-3 text-neutral-300 max-w-2xl leading-relaxed">
          Point a <code className="text-orange-300">{`<meta property="og:image">`}</code>{" "}
          tag at this Worker with the source page URL. The Worker fetches
          the page, extracts <code className="text-orange-300">{`<title>`}</code>{" "}
          and meta tags, renders a JSX template via Satori + Resvg, and
          caches the PNG forever in R2. No SDK, no build step, no Next.js
          required.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-orange-300 mb-2">
          Try it · paste any URL, see the rendered card
        </h2>
        <p className="text-sm text-neutral-400 mb-4 max-w-2xl">
          Live render running on a Cloudflare Worker. Pick a sample URL or
          paste your own. Title and description auto-extract from the page;
          override them with the inputs if you want different copy in the
          card.
        </p>
        <SharePlayground />
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          How it stays cheap
        </h2>
        <ul className="text-sm text-neutral-300 space-y-2 max-w-2xl leading-relaxed">
          <li>
            • First request for a unique{" "}
            <code className="text-orange-300">(url, platform)</code> renders
            and caches to R2. Every subsequent request — Twitter, Slack,
            Discord, real readers — serves from R2 with free egress.
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
          The default template is a black background with the page title in
          bold, the description below, and the site name with an accent dot
          at the bottom. To change the layout, fork the repo and edit{" "}
          <code className="text-orange-300">share/src/templates/default.tsx</code>{" "}
          — it&rsquo;s a regular React-shaped JSX function. Drop new
          variants into the same directory and select them via{" "}
          <code className="text-orange-300">?template=name</code>.
        </p>
      </section>
    </main>
  );
}
