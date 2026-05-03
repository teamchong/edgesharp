"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Image optimization" },
  { href: "/og/", label: "OG cards" },
];

export default function Tabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-neutral-800 mb-8">
      {TABS.map((tab) => {
        const isActive =
          tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
              isActive
                ? "border-orange-400 text-orange-200"
                : "border-transparent text-neutral-400 hover:text-neutral-200",
            ].join(" ")}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
