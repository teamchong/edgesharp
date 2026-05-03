import Link from "next/link";

export default function Header() {
  return (
    <nav className="flex items-center justify-between gap-5 text-sm mb-2">
      <Link
        href="/"
        className="font-semibold tracking-tight text-neutral-100 hover:text-orange-200"
      >
        edgesharp
      </Link>
      <div className="flex items-center gap-5">
        <a
          href="https://edgesharp.teamchong.net"
          className="text-neutral-400 hover:text-orange-200"
        >
          Docs
        </a>
        <a
          href="https://github.com/teamchong/edgesharp"
          className="text-neutral-400 hover:text-orange-200"
        >
          GitHub
        </a>
        <a
          href="https://deploy.workers.cloudflare.com/?url=https://github.com/teamchong/edgesharp"
          className="px-3 py-1.5 rounded-md bg-orange-500/10 text-orange-200 border border-orange-400/30 hover:bg-orange-500/20"
        >
          Deploy to Cloudflare
        </a>
      </div>
    </nav>
  );
}
