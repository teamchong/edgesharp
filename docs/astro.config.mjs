import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  // Canonical docs URL. Update if you deploy docs to a different host.
  site: "https://edgesharp.teamchong.net",
  integrations: [
    starlight({
      title: "edgesharp",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/teamchong/edgesharp",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Getting Started", link: "/getting-started/" },
        { label: "Configuration", link: "/configuration/" },
        { label: "How It Works", link: "/how-it-works/" },
        { label: "Next.js Integration", link: "/nextjs-integration/" },
        { label: "Backend Modes", link: "/backend-modes/" },
        { label: "Architecture", link: "/architecture/" },
        { label: "Performance", link: "/performance/" },
        { label: "Conformance", link: "/conformance/" },
        { label: "Compatibility", link: "/compatibility/" },
        { label: "Limits", link: "/limits/" },
        { label: "Deployment", link: "/deployment/" },
        { label: "Production Hardening", link: "/production-hardening/" },
      ],
    }),
  ],
});
