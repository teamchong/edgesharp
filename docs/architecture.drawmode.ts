const d = new Diagram();

// Row 0: Browser
const browser = d.addBox("Browser\n(Next.js app)", { row: 0, col: 1, color: "frontend" });

// Row 1: Worker
const worker = d.addBox("edgesharp Worker\n/_next/image", { row: 1, col: 1, color: "orchestration" });

// Row 2: Cache layer
const cacheApi = d.addBox("Cache API\n(L1, ~5ms)", { row: 2, col: 0, color: "storage" });
const r2 = d.addBox("R2 Bucket\n(L2, ~20ms)", { row: 2, col: 2, color: "storage" });

// Row 3: Transform backends
const doPools = d.addBox("Image DO Pool\nimg-slot-{0..7}", { row: 3, col: 0, color: "backend" });
const cfImages = d.addBox("CF Images\n(AVIF only)", { row: 3, col: 2, color: "ai" });

// Row 4: WASM engine
const wasmEngine = d.addBox("Zig WASM\nSIMD128 + FMA", { row: 4, col: 0, color: "backend" });

// Row 4: Origin
const origin = d.addBox("Next.js Origin\n(your app)", { row: 4, col: 2, color: "frontend" });

// Connections
d.connect(browser, worker, "/_next/image?url=...&w=640&q=75");
d.connect(worker, cacheApi, "L1 check");
d.connect(worker, r2, "L2 check");
d.connect(worker, origin, "fetch original");
d.connect(worker, doPools, "wasm mode");
d.connect(worker, cfImages, "avif (auto mode)");
d.connect(doPools, wasmEngine, "decode → resize → encode");

// Groups
d.addGroup("Cache", [cacheApi, r2]);
d.addGroup("Transform", [doPools, cfImages, wasmEngine]);

return d.render({ format: ["svg", "png"], path: "docs/public/architecture" });
