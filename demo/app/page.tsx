import Image from "next/image";
import Playground from "./Playground";

const NEXT_CONFIG_SNIPPET = `// next.config.mjs — the only file you change.
export default {
  images: {
    loader: 'custom',
    loaderFile: './node_modules/edgesharp/dist/loader.js',
  },
};`;

const USAGE_SNIPPET = `// app/page.tsx — your <Image> components don't change.
import Image from 'next/image';

<Image src="/photo.jpg" alt="" width={1600} height={1200} />`;

export default function Home() {
  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <header className="mb-12">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">edgesharp</h1>
          <span className="text-neutral-400 text-sm">
            Cloudflare-native image optimization for Next.js
          </span>
        </div>
        <p className="mt-3 text-neutral-300 max-w-2xl leading-relaxed">
          This page, the source images, and the{" "}
          <code className="text-orange-300">/_next/image</code> API are all
          served by the same Cloudflare Worker. Every{" "}
          <code className="text-orange-300">{`<Image>`}</code> below is an
          unmodified <code className="text-orange-300">next/image</code>{" "}
          component — only the loader changed. The browser fetches each variant
          from the same origin; the Worker decodes, Lanczos-resizes, and
          re-encodes via Zig WASM SIMD on the way out.
        </p>
      </header>

      <section className="mb-12">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          The integration
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CodeCard title="1. next.config.mjs" code={NEXT_CONFIG_SNIPPET} />
          <CodeCard title="2. Use <Image /> as you already do" code={USAGE_SNIPPET} />
        </div>
        <p className="text-xs text-neutral-500 mt-3">
          Same-origin deploy: the loader emits relative URLs, so there&apos;s
          nothing to configure at build time. Drop edgesharp on any domain;
          your <code className="text-orange-300">{`<Image>`}</code> components
          stay exactly as written.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          Try it · paste any URL, pick any size or format
        </h2>
        <Playground />
      </section>

      <section className="mb-12">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          Hero photo · 4K source, browser picks the right variant
        </h2>
        <div className="rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900">
          <Image
            src="/demo/photo-4k.jpg"
            alt="Synthetic photo, 4000×3000"
            width={1600}
            height={1200}
            sizes="(min-width: 1024px) 1200px, 100vw"
            priority
            className="w-full h-auto"
          />
        </div>
        <p className="text-xs text-neutral-500 mt-3">
          Source: 4000×3000 JPEG, ~3.7&nbsp;MB. Inspect this image in
          DevTools — its <code className="text-orange-300">srcSet</code>{" "}
          contains 8 widths, all served as WebP from the Worker.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          Three different content types · same loader
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Tile
            label="Photographic content (2K)"
            src="/demo/photo.jpg"
            width={1200}
            height={900}
            note="Compresses well as WebP — typical 90%+ savings vs JPEG q=92 source."
          />
          <Tile
            label="Flat UI mock (PNG → PNG)"
            src="/demo/ui.png"
            width={1280}
            height={800}
            note="Hard edges and large flat regions. PNG output preserves alpha and stays sharp."
          />
          <Tile
            label="Phone portrait (EXIF auto-rotate)"
            src="/demo/portrait.jpg"
            width={900}
            height={1200}
            note="Stored landscape with EXIF orientation=6. The decoder rotates 90° CW so it renders upright."
          />
        </div>
      </section>

      <section className="mb-12">
        <h2 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide mb-4">
          The same image at every Next.js width
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {[16, 128, 384, 640, 1080, 1920, 2048, 3840].map((w) => (
            <div
              key={w}
              className="relative rounded-md overflow-hidden border border-neutral-800 bg-neutral-900"
              style={{ aspectRatio: "4 / 3" }}
            >
              <Image
                src="/demo/photo.jpg"
                alt={`${w}w variant`}
                width={w}
                height={Math.round((w * 3) / 4)}
                sizes={`${w}px`}
                className="w-full h-full object-contain"
              />
              <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[10px] text-neutral-100 font-mono py-0.5 text-center">
                {w}w
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-neutral-500 mt-3">
          edgesharp generates each variant on first request, then caches in R2.
          Free egress means repeat visitors don&apos;t cost bandwidth.
        </p>
      </section>

      <footer className="text-center text-neutral-500 text-sm pb-8 pt-6 border-t border-neutral-900">
        <p>
          Built with Zig{" "}
          <a
            href="https://ziglang.org"
            className="text-orange-300 hover:text-orange-200"
          >
            0.16
          </a>{" "}
          · runs on Cloudflare Workers + R2 (free egress) ·{" "}
          <a
            href="https://github.com/teamchong/edgesharp"
            className="text-orange-300 hover:text-orange-200"
          >
            source on GitHub
          </a>
        </p>
      </footer>
    </main>
  );
}

function Tile({
  label,
  src,
  width,
  height,
  note,
}: {
  label: string;
  src: string;
  width: number;
  height: number;
  note: string;
}) {
  return (
    <div className="rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900">
      <div
        className="bg-neutral-950 flex items-center justify-center overflow-hidden"
        style={{ aspectRatio: "4 / 3" }}
      >
        <Image
          src={src}
          alt={label}
          width={width}
          height={height}
          sizes="(min-width: 768px) 33vw, 100vw"
          className="w-full h-full object-contain"
        />
      </div>
      <div className="px-4 py-3 border-t border-neutral-800">
        <p className="text-sm font-semibold text-neutral-200">{label}</p>
        <p className="text-xs text-neutral-500 mt-1 leading-snug">{note}</p>
      </div>
    </div>
  );
}

function CodeCard({ title, code }: { title: string; code: string }) {
  return (
    <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4">
      <h3 className="text-xs font-semibold text-neutral-400 mb-2 uppercase tracking-wide">
        {title}
      </h3>
      <pre className="text-xs font-mono text-neutral-300 leading-relaxed overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}
