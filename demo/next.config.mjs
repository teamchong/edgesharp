// Next.js demo for edgesharp.
//
// Three lines of integration:
//   1. images.loader = 'custom'
//   2. images.loaderFile points at a tiny re-export file
//   3. (in that file) export { default } from 'edgesharp/loader'
//
// Static export (output: 'export') so the entire demo can ship as part of
// the Worker's bundled assets — one Worker URL serves both the demo and the
// /_next/image API.

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    loader: "custom",
    loaderFile: "./node_modules/edgesharp/dist/loader.js",
  },
};

export default nextConfig;
