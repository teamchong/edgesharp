import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "conformance/fixtures");

const server = http.createServer((req, res) => {
  const safePath = req.url.replace(/\.\./g, "").replace(/^\//, "");
  const filePath = path.join(fixturesDir, safePath);

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif", ".html": "text/html" };
    res.writeHead(200, { "Content-Type": mimeMap[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

const port = parseInt(process.env.PORT ?? "3456", 10);
server.listen(port, () => console.log(`Origin server listening on :${port}`));
