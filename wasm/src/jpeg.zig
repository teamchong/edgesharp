/// JPEG decoder for WASM freestanding.
///
/// Baseline-sequential 8-bit JPEGs (4:4:4 / 4:2:2 / 4:2:0 plus grayscale,
/// standard Huffman) decode through the hand-rolled Zig path below.
/// Progressive JPEGs (SOF2) decode through the vendored stb_image wrapper.
/// Both paths produce the same RGBA output for the same input bytes;
/// downstream resize and encode are unaware of which decoder ran.
/// Arithmetic coding, CMYK, and 12-bit precision are not supported.
const std = @import("std");
const math = std.math;
const mem = @import("memory.zig");

extern fn edgesharp_decode_progressive_jpeg(
    src: [*]const u8,
    src_len: c_int,
    out_width: *c_int,
    out_height: *c_int,
) ?[*]u8;

extern fn free(ptr: ?*anyopaque) void;

const MAX_COMPONENTS = 4;
const MAX_HUFFMAN_TABLES = 4;

const HuffTable = struct {
    // Fast lookup: up to 8-bit codes
    fast: [256]u8,
    // Slow lookup for codes > 8 bits
    maxcode: [17]i32,
    delta: [17]i32,
    size: [256]u8,
    value: [256]u8,

    fn init() HuffTable {
        return .{
            .fast = [_]u8{255} ** 256,
            .maxcode = [_]i32{-1} ** 17,
            .delta = [_]i32{0} ** 17,
            .size = [_]u8{0} ** 256,
            .value = [_]u8{0} ** 256,
        };
    }
};

const Component = struct {
    id: u8 = 0,
    h_samp: u8 = 1,
    v_samp: u8 = 1,
    quant_id: u8 = 0,
    dc_table: u8 = 0,
    ac_table: u8 = 0,
    dc_pred: i32 = 0,
};

const JpegState = struct {
    width: u32 = 0,
    height: u32 = 0,
    num_components: u8 = 0,
    components: [MAX_COMPONENTS]Component = [_]Component{.{}} ** MAX_COMPONENTS,
    quant: [4][64]u16 = [_][64]u16{[_]u16{0} ** 64} ** 4,
    dc_huff: [MAX_HUFFMAN_TABLES]HuffTable = undefined,
    ac_huff: [MAX_HUFFMAN_TABLES]HuffTable = undefined,
    max_h_samp: u8 = 1,
    max_v_samp: u8 = 1,
    /// EXIF orientation (1..8). 1 = no transform. Spec: TIFF tag 0x0112.
    orientation: u8 = 1,

    fn init() JpegState {
        var s: JpegState = .{};
        for (0..MAX_HUFFMAN_TABLES) |i| {
            s.dc_huff[i] = HuffTable.init();
            s.ac_huff[i] = HuffTable.init();
        }
        return s;
    }
};

const BitReader = struct {
    data: []const u8,
    pos: usize,
    bits: u32,
    count: u8,

    fn init(data: []const u8) BitReader {
        return .{ .data = data, .pos = 0, .bits = 0, .count = 0 };
    }

    fn nextByte(self: *BitReader) ?u8 {
        while (self.pos < self.data.len) {
            const b = self.data[self.pos];
            self.pos += 1;
            if (b == 0xFF) {
                if (self.pos < self.data.len and self.data[self.pos] == 0x00) {
                    self.pos += 1; // byte-stuffed FF00 → FF
                    return 0xFF;
                }
                // Marker found, stop
                return null;
            }
            return b;
        }
        return null;
    }

    fn ensureBits(self: *BitReader, n: u8) bool {
        while (self.count < n) {
            const b = self.nextByte() orelse return false;
            self.bits = (self.bits << 8) | b;
            self.count += 8;
        }
        return true;
    }

    fn peekBits(self: *BitReader, n: u8) u32 {
        return (self.bits >> @intCast(self.count - n)) & ((@as(u32, 1) << @intCast(n)) - 1);
    }

    fn dropBits(self: *BitReader, n: u8) void {
        self.count -= n;
    }

    fn getBits(self: *BitReader, n: u8) ?i32 {
        if (n == 0) return 0;
        if (!self.ensureBits(n)) return null;
        const val: i32 = @intCast(self.peekBits(n));
        self.dropBits(n);
        return val;
    }

    fn decodeHuffman(self: *BitReader, table: *const HuffTable) ?u8 {
        if (!self.ensureBits(8)) {
            // Try with fewer bits
            if (self.count == 0) return null;
        }

        // Fast path: 8-bit lookup
        if (self.count >= 8) {
            const idx = self.peekBits(8);
            const fast = table.fast[idx];
            if (fast != 255) {
                self.dropBits(table.size[fast]);
                return table.value[fast];
            }
        }

        // Slow path: bit-by-bit
        if (!self.ensureBits(16)) {
            // Work with what we have
        }
        var code: i32 = 0;
        for (1..17) |len| {
            if (self.count < len) break;
            code = (code << 1) | @as(i32, @intCast(self.peekBits(@intCast(len)) & 1));
            // Rebuild code from MSB
            const actual_code: i32 = @intCast(self.peekBits(@intCast(len)));
            if (actual_code <= table.maxcode[len]) {
                self.dropBits(@intCast(len));
                const idx: usize = @intCast(actual_code + table.delta[len]);
                return table.value[idx];
            }
        }
        return null;
    }
};

/// Extend a partial value to a signed coefficient.
fn extend(val: i32, bits: u8) i32 {
    if (bits == 0) return 0;
    const threshold: i32 = @as(i32, 1) << @intCast(bits - 1);
    if (val < threshold) {
        return val - (@as(i32, 1) << @intCast(bits)) + 1;
    }
    return val;
}

// Zigzag order for 8x8 block
const zigzag = [64]u8{
    0,  1,  8,  16, 9,  2,  3,  10,
    17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
};

/// Decode one 8×8 block of DCT coefficients.
fn decodeBlock(
    reader: *BitReader,
    dc_table: *const HuffTable,
    ac_table: *const HuffTable,
    quant: *const [64]u16,
    dc_pred: *i32,
    block: *[64]i32,
) bool {
    @memset(block, 0);

    // DC coefficient
    const dc_len = reader.decodeHuffman(dc_table) orelse return false;
    if (dc_len > 0) {
        const dc_val = reader.getBits(dc_len) orelse return false;
        dc_pred.* += extend(dc_val, dc_len);
    }
    block[0] = dc_pred.* * @as(i32, quant[0]);

    // AC coefficients
    var k: usize = 1;
    while (k < 64) {
        const rs = reader.decodeHuffman(ac_table) orelse return false;
        const run = rs >> 4;
        const size = rs & 0x0F;

        if (size == 0) {
            if (run == 0) break; // EOB
            if (run == 0x0F) {
                k += 16; // ZRL (skip 16 zeros)
                continue;
            }
            break;
        }

        k += run;
        if (k >= 64) break;

        const ac_val = reader.getBits(size) orelse return false;
        block[zigzag[k]] = extend(ac_val, size) * @as(i32, quant[k]);
        k += 1;
    }

    return true;
}

/// 8×8 separable IDCT in f32. The DC-only branch handles the common case
/// where AC coefficients quantize to zero: IDCT of a DC-only vector is
/// the scalar (DC * c0/2) broadcast to all 8 outputs, that's the closed
/// form, not an approximation.
const cos_table_f32 = blk: {
    @setEvalBranchQuota(10_000);
    var table: [8][8]f32 = undefined;
    for (0..8) |k| {
        for (0..8) |n| {
            const ck: f32 = if (k == 0) 1.0 / @sqrt(2.0) else 1.0;
            table[k][n] = ck * @cos((2.0 * @as(f32, @floatFromInt(n)) + 1.0) * @as(f32, @floatFromInt(k)) * std.math.pi / 16.0);
        }
    }
    break :blk table;
};

inline fn idct1dRow(in: [8]f32, out: *[8]f32) void {
    const c = cos_table_f32;
    for (0..8) |x| {
        const sum = in[0] * c[0][x] + in[1] * c[1][x] + in[2] * c[2][x] + in[3] * c[3][x]
                  + in[4] * c[4][x] + in[5] * c[5][x] + in[6] * c[6][x] + in[7] * c[7][x];
        out[x] = sum * 0.5;
    }
}

fn idct2d(block: *[64]i32) void {
    var temp: [64]f32 = undefined;

    // Row pass
    for (0..8) |row| {
        const r = block[row * 8 ..][0..8];
        if (r[1] == 0 and r[2] == 0 and r[3] == 0 and r[4] == 0 and r[5] == 0 and r[6] == 0 and r[7] == 0) {
            const dc: f32 = @as(f32, @floatFromInt(r[0])) * (1.0 / @sqrt(2.0)) * 0.5;
            const t = temp[row * 8 ..][0..8];
            t[0] = dc; t[1] = dc; t[2] = dc; t[3] = dc;
            t[4] = dc; t[5] = dc; t[6] = dc; t[7] = dc;
            continue;
        }
        const f = [_]f32{
            @floatFromInt(r[0]), @floatFromInt(r[1]), @floatFromInt(r[2]), @floatFromInt(r[3]),
            @floatFromInt(r[4]), @floatFromInt(r[5]), @floatFromInt(r[6]), @floatFromInt(r[7]),
        };
        idct1dRow(f, temp[row * 8 ..][0..8]);
    }

    // Column pass
    for (0..8) |col| {
        const f = [_]f32{
            temp[0 * 8 + col], temp[1 * 8 + col], temp[2 * 8 + col], temp[3 * 8 + col],
            temp[4 * 8 + col], temp[5 * 8 + col], temp[6 * 8 + col], temp[7 * 8 + col],
        };
        const c = cos_table_f32;
        for (0..8) |y| {
            const sum = f[0] * c[0][y] + f[1] * c[1][y] + f[2] * c[2][y] + f[3] * c[3][y]
                      + f[4] * c[4][y] + f[5] * c[5][y] + f[6] * c[6][y] + f[7] * c[7][y];
            block[y * 8 + col] = @intFromFloat(@round(sum * 0.5));
        }
    }
}

fn clampU8(val: i32) u8 {
    if (val < 0) return 0;
    if (val > 255) return 255;
    return @intCast(val);
}

/// Build a Huffman table from DHT segment data.
fn buildHuffTable(table: *HuffTable, counts: [16]u8, symbols: []const u8) void {
    var idx: usize = 0;
    var code: u32 = 0;

    for (0..16) |len| {
        const bit_len: u5 = @intCast(len + 1);
        table.delta[len + 1] = @as(i32, @intCast(idx)) - @as(i32, @intCast(code));

        for (0..counts[len]) |_| {
            if (idx >= 256) break;
            table.size[idx] = @intCast(len + 1);
            table.value[idx] = symbols[idx];

            // Populate fast table for codes <= 8 bits
            if (len < 8) {
                const pad = @as(u8, 8) - bit_len;
                const base = code << @intCast(pad);
                const count = @as(u32, 1) << @intCast(pad);
                for (0..count) |k| {
                    const fast_idx = base + k;
                    if (fast_idx < 256) {
                        table.fast[fast_idx] = @intCast(idx);
                    }
                }
            }

            idx += 1;
            code += 1;
        }
        table.maxcode[len + 1] = @intCast(code - 1);
        code <<= 1;
    }
}

/// Parse the APP1/Exif segment and return the orientation tag (1..8).
/// Returns 1 (identity) if no Exif block, no orientation tag, or any parse error.
fn parseExifOrientation(seg: []const u8) u8 {
    // APP1 payload starts with "Exif\0\0" (6 bytes), then a TIFF header.
    if (seg.len < 14 or !std.mem.eql(u8, seg[0..6], "Exif\x00\x00")) return 1;
    const tiff = seg[6..];

    // TIFF byte order: "II" little-endian, "MM" big-endian.
    const little = std.mem.eql(u8, tiff[0..2], "II");
    const big = std.mem.eql(u8, tiff[0..2], "MM");
    if (!little and !big) return 1;
    const endian: std.builtin.Endian = if (little) .little else .big;

    if (std.mem.readInt(u16, tiff[2..4], endian) != 0x002A) return 1; // magic
    const ifd0_off = std.mem.readInt(u32, tiff[4..8], endian);
    if (ifd0_off + 2 > tiff.len) return 1;

    const entry_count = std.mem.readInt(u16, tiff[ifd0_off..][0..2], endian);
    const entries_start = ifd0_off + 2;
    if (entries_start + @as(usize, entry_count) * 12 > tiff.len) return 1;

    var i: usize = 0;
    while (i < entry_count) : (i += 1) {
        const e = entries_start + i * 12;
        const tag = std.mem.readInt(u16, tiff[e..][0..2], endian);
        if (tag != 0x0112) continue; // Orientation
        const fmt = std.mem.readInt(u16, tiff[e + 2 ..][0..2], endian);
        if (fmt != 3) return 1; // SHORT
        // Value is inline (count=1, type SHORT fits in 4 bytes)
        const val = std.mem.readInt(u16, tiff[e + 8 ..][0..2], endian);
        if (val >= 1 and val <= 8) return @intCast(val);
        return 1;
    }
    return 1;
}

/// Apply EXIF orientation to the RGBA buffer at out (header + pixels).
/// Mutates the dimensions header for 90/270 rotations and rewrites pixels in place
/// via a scratch buffer. orientation 1 is a no-op.
fn applyOrientation(out: []u8, orientation: u8) ?void {
    if (orientation == 1 or orientation > 8) return {};

    const w = std.mem.readInt(u32, out[0..4], .little);
    const h = std.mem.readInt(u32, out[4..8], .little);
    const px_count = @as(usize, w) * @as(usize, h);
    const src = out[8..][0 .. px_count * 4];

    const scratch = mem.allocSlice(px_count * 4) orelse return null;
    defer mem.freeSlice(scratch);
    @memcpy(scratch, src);

    const swap_dims = orientation >= 5; // 5..8 transpose w/h
    const out_w: u32 = if (swap_dims) h else w;
    const out_h: u32 = if (swap_dims) w else h;

    var y: u32 = 0;
    while (y < h) : (y += 1) {
        var x: u32 = 0;
        while (x < w) : (x += 1) {
            // Map (x, y) in source coords → (dx, dy) in destination coords.
            const dx: u32, const dy: u32 = switch (orientation) {
                2 => .{ w - 1 - x, y }, // flip horizontal
                3 => .{ w - 1 - x, h - 1 - y }, // rotate 180
                4 => .{ x, h - 1 - y }, // flip vertical
                5 => .{ y, x }, // transpose
                6 => .{ h - 1 - y, x }, // rotate 90 CW
                7 => .{ h - 1 - y, w - 1 - x }, // transverse
                8 => .{ y, w - 1 - x }, // rotate 90 CCW
                else => unreachable,
            };
            const sidx = (y * w + x) * 4;
            const didx = (dy * out_w + dx) * 4;
            src[didx + 0] = scratch[sidx + 0];
            src[didx + 1] = scratch[sidx + 1];
            src[didx + 2] = scratch[sidx + 2];
            src[didx + 3] = scratch[sidx + 3];
        }
    }

    std.mem.writeInt(u32, out[0..4], out_w, .little);
    std.mem.writeInt(u32, out[4..8], out_h, .little);
}

/// Scan markers for SOF2 (progressive JPEG). Returns true on the first SOF2
/// found; returns false on any other SOF (SOF0/1/3/...) or unparseable input.
/// We don't need to fully parse the file here, just walk the marker chain
/// until we hit any SOF, since SOFn always precedes SOS.
fn jpegIsProgressive(src: []const u8) bool {
    if (src.len < 4 or src[0] != 0xFF or src[1] != 0xD8) return false;
    var pos: usize = 2;
    while (pos + 3 < src.len) {
        if (src[pos] != 0xFF) { pos += 1; continue; }
        const marker = src[pos + 1];
        pos += 2;
        if (marker == 0xFF or marker == 0x00 or marker == 0x01) continue;
        if (marker == 0xD9) return false; // EOI before SOF, malformed, let baseline path return null.
        if (marker >= 0xD0 and marker <= 0xD7) continue; // RST has no length
        // SOFn = 0xC0..0xCF except 0xC4 (DHT) and 0xC8 (reserved).
        if (marker >= 0xC0 and marker <= 0xCF and marker != 0xC4 and marker != 0xC8) {
            return marker == 0xC2; // SOF2 = progressive DCT
        }
        if (pos + 2 > src.len) return false;
        const seg_len = std.mem.readInt(u16, src[pos..][0..2], .big);
        if (seg_len < 2) return false;
        pos += seg_len;
    }
    return false;
}

/// Hand off to stb_image's progressive code path. stb returns a malloc'd RGBA
/// buffer; we copy it into our arena so the rest of the pipeline sees the
/// same `[width LE][height LE][rgba]` layout the baseline path produces.
fn decodeProgressiveViaStb(src: []const u8) ?[*]u8 {
    var w: c_int = 0;
    var h: c_int = 0;
    const stb_buf = edgesharp_decode_progressive_jpeg(src.ptr, @intCast(src.len), &w, &h) orelse return null;
    defer free(@ptrCast(stb_buf));

    if (w <= 0 or h <= 0) return null;
    const width: u32 = @intCast(w);
    const height: u32 = @intCast(h);
    const pixel_bytes = width * height * 4;
    const out_size: usize = 8 + pixel_bytes;

    const out = mem.allocSlice(out_size) orelse return null;
    std.mem.writeInt(u32, out[0..4], width, .little);
    std.mem.writeInt(u32, out[4..8], height, .little);
    @memcpy(out[8..][0..pixel_bytes], stb_buf[0..pixel_bytes]);
    return out.ptr;
}

/// Parse JPEG markers and decode to RGBA.
///
/// Output layout: [4 bytes width LE][4 bytes height LE][rgba pixels].
/// Caller frees via mem.freeSlice. Returns null on any decode error.
///
/// Dispatch:
///   SOF0 (baseline-sequential) → in-Zig decoder below.
///   SOF2 (progressive)         → stb_image wrapper (stb_jpeg_wrapper.c).
///   other SOF flavors          → unsupported, returns null.
pub fn decode(src: []const u8) ?[*]u8 {
    if (src.len < 2 or src[0] != 0xFF or src[1] != 0xD8) return null;

    if (jpegIsProgressive(src)) {
        return decodeProgressiveViaStb(src);
    }

    var state = JpegState.init();
    var pos: usize = 2;
    var scan_data_start: usize = 0;
    var scan_data_end: usize = 0;

    // Parse markers
    while (pos + 1 < src.len) {
        if (src[pos] != 0xFF) { pos += 1; continue; }
        const marker = src[pos + 1];
        pos += 2;
        if (marker == 0xFF or marker == 0x00 or marker == 0x01) continue;
        if (marker == 0xD9) break; // EOI

        // Markers without length
        if (marker >= 0xD0 and marker <= 0xD7) continue; // RST

        if (pos + 2 > src.len) return null;
        const seg_len = std.mem.readInt(u16, src[pos..][0..2], .big);
        if (seg_len < 2 or pos + seg_len > src.len) return null;
        const seg = src[pos + 2 .. pos + seg_len];

        switch (marker) {
            0xC0 => { // SOF0, baseline DCT
                if (seg.len < 6) return null;
                if (seg[0] != 8) return null; // 8-bit only
                state.height = std.mem.readInt(u16, seg[1..3], .big);
                state.width = std.mem.readInt(u16, seg[3..5], .big);
                state.num_components = seg[5];
                if (state.num_components > MAX_COMPONENTS) return null;
                if (seg.len < 6 + @as(usize, state.num_components) * 3) return null;

                for (0..state.num_components) |i| {
                    const off = 6 + i * 3;
                    state.components[i].id = seg[off];
                    state.components[i].h_samp = seg[off + 1] >> 4;
                    state.components[i].v_samp = seg[off + 1] & 0x0F;
                    state.components[i].quant_id = seg[off + 2];
                    if (state.components[i].h_samp > state.max_h_samp)
                        state.max_h_samp = state.components[i].h_samp;
                    if (state.components[i].v_samp > state.max_v_samp)
                        state.max_v_samp = state.components[i].v_samp;
                }
            },
            0xC4 => { // DHT. Huffman table
                var dht_pos: usize = 0;
                while (dht_pos < seg.len) {
                    const info = seg[dht_pos];
                    dht_pos += 1;
                    const table_class = info >> 4; // 0=DC, 1=AC
                    const table_id = info & 0x0F;
                    if (table_id >= MAX_HUFFMAN_TABLES) return null;

                    var counts: [16]u8 = undefined;
                    var total: usize = 0;
                    for (0..16) |i| {
                        counts[i] = seg[dht_pos + i];
                        total += counts[i];
                    }
                    dht_pos += 16;

                    if (dht_pos + total > seg.len) return null;
                    const symbols = seg[dht_pos..][0..total];
                    dht_pos += total;

                    if (table_class == 0) {
                        buildHuffTable(&state.dc_huff[table_id], counts, symbols);
                    } else {
                        buildHuffTable(&state.ac_huff[table_id], counts, symbols);
                    }
                }
            },
            0xDB => { // DQT, quantization table
                var dqt_pos: usize = 0;
                while (dqt_pos < seg.len) {
                    const info = seg[dqt_pos];
                    dqt_pos += 1;
                    const precision = info >> 4; // 0=8-bit, 1=16-bit
                    const table_id = info & 0x0F;
                    if (table_id >= 4) return null;

                    for (0..64) |i| {
                        if (precision == 0) {
                            state.quant[table_id][i] = seg[dqt_pos];
                            dqt_pos += 1;
                        } else {
                            state.quant[table_id][i] = std.mem.readInt(u16, seg[dqt_pos..][0..2], .big);
                            dqt_pos += 2;
                        }
                    }
                }
            },
            0xDA => { // SOS, start of scan
                if (seg.len < 1) return null;
                const ns = seg[0];
                if (seg.len < 1 + @as(usize, ns) * 2 + 3) return null;

                for (0..ns) |i| {
                    const comp_id = seg[1 + i * 2];
                    const tables = seg[2 + i * 2];
                    // Find matching component
                    for (0..state.num_components) |c| {
                        if (state.components[c].id == comp_id) {
                            state.components[c].dc_table = tables >> 4;
                            state.components[c].ac_table = tables & 0x0F;
                            break;
                        }
                    }
                }

                scan_data_start = pos + seg_len;
                // Find end of scan data (next 0xFF marker that isn't stuffed or RST)
                var sp = scan_data_start;
                while (sp + 1 < src.len) {
                    if (src[sp] == 0xFF and src[sp + 1] != 0x00 and
                        (src[sp + 1] < 0xD0 or src[sp + 1] > 0xD7))
                    {
                        break;
                    }
                    sp += 1;
                }
                scan_data_end = sp;
            },
            0xE1 => { // APP1, usually Exif
                state.orientation = parseExifOrientation(seg);
            },
            else => {}, // Skip other APP, COM, etc.
        }

        pos += seg_len;
    }

    if (state.width == 0 or state.height == 0 or scan_data_end <= scan_data_start) return null;

    // Decode scan data, then apply EXIF orientation in place if needed.
    const out_ptr = decodeScanData(&state, src[scan_data_start..scan_data_end]) orelse return null;
    if (state.orientation != 1) {
        const w = std.mem.readInt(u32, out_ptr[0..4], .little);
        const h = std.mem.readInt(u32, out_ptr[4..8], .little);
        const out_size = 8 + @as(usize, w) * @as(usize, h) * 4;
        applyOrientation(out_ptr[0..out_size], state.orientation) orelse {
            mem.free(out_ptr, out_size);
            return null;
        };
    }
    return out_ptr;
}

fn decodeScanData(state: *JpegState, scan_data: []const u8) ?[*]u8 {
    const w = state.width;
    const h = state.height;
    const pixel_count = w * h;
    const out_size = 8 + pixel_count * 4;
    const out = mem.allocSlice(out_size) orelse return null;

    std.mem.writeInt(u32, out[0..4], w, .little);
    std.mem.writeInt(u32, out[4..8], h, .little);
    const rgba = out[8..];

    var reader = BitReader.init(scan_data);

    // Reset DC predictors
    for (0..MAX_COMPONENTS) |i| state.components[i].dc_pred = 0;

    const mcu_w = @as(u32, state.max_h_samp) * 8;
    const mcu_h = @as(u32, state.max_v_samp) * 8;
    const mcus_x = (w + mcu_w - 1) / mcu_w;
    const mcus_y = (h + mcu_h - 1) / mcu_h;

    // Allocate component planes
    const plane_w = mcus_x * mcu_w;
    const plane_h = mcus_y * mcu_h;

    var planes: [MAX_COMPONENTS]?[]u8 = [_]?[]u8{null} ** MAX_COMPONENTS;
    defer for (0..state.num_components) |i| {
        if (planes[i]) |p| mem.freeSlice(p);
    };

    for (0..state.num_components) |i| {
        const comp_w = plane_w * state.components[i].h_samp / state.max_h_samp;
        const comp_h = plane_h * state.components[i].v_samp / state.max_v_samp;
        planes[i] = mem.allocSlice(comp_w * comp_h) orelse {
            // Clean up already allocated planes
            for (0..i) |j| {
                if (planes[j]) |p| mem.freeSlice(p);
                planes[j] = null;
            }
            mem.freeSlice(out);
            return null;
        };
    }

    // Decode MCUs
    var block: [64]i32 = undefined;

    for (0..mcus_y) |mcu_y| {
        for (0..mcus_x) |mcu_x| {
            for (0..state.num_components) |ci| {
                const comp = &state.components[ci];
                const comp_w = plane_w * comp.h_samp / state.max_h_samp;

                for (0..comp.v_samp) |bv| {
                    for (0..comp.h_samp) |bh| {
                        if (!decodeBlock(
                            &reader,
                            &state.dc_huff[comp.dc_table],
                            &state.ac_huff[comp.ac_table],
                            &state.quant[comp.quant_id],
                            &comp.dc_pred,
                            &block,
                        )) {
                            mem.freeSlice(out);
                            return null;
                        }

                        idct2d(&block);

                        // Write block to component plane
                        const base_x = mcu_x * comp.h_samp * 8 + bh * 8;
                        const base_y = mcu_y * comp.v_samp * 8 + bv * 8;
                        const plane = planes[ci].?;

                        for (0..8) |y| {
                            for (0..8) |x| {
                                const px = base_x + x;
                                const py = base_y + y;
                                const val = block[y * 8 + x] + 128; // level shift
                                plane[py * comp_w + px] = clampU8(val);
                            }
                        }
                    }
                }
            }
        }
    }

    // Convert to RGBA
    if (state.num_components == 1) {
        // Grayscale
        const plane = planes[0].?;
        for (0..h) |y| {
            for (0..w) |x| {
                const v = plane[y * plane_w + x];
                const idx = (y * w + x) * 4;
                rgba[idx + 0] = v;
                rgba[idx + 1] = v;
                rgba[idx + 2] = v;
                rgba[idx + 3] = 255;
            }
        }
    } else if (state.num_components >= 3) {
        // YCbCr → RGB with chroma upsampling
        const y_plane = planes[0].?;
        const cb_plane = planes[1].?;
        const cr_plane = planes[2].?;
        const cb_w = plane_w * state.components[1].h_samp / state.max_h_samp;
        const cr_w = plane_w * state.components[2].h_samp / state.max_h_samp;

        for (0..h) |py| {
            for (0..w) |px| {
                const yy: i32 = y_plane[py * plane_w + px];
                // Chroma upsampling (nearest neighbor)
                const cb_x = px * state.components[1].h_samp / state.max_h_samp;
                const cb_y = py * state.components[1].v_samp / state.max_v_samp;
                const cr_x = px * state.components[2].h_samp / state.max_h_samp;
                const cr_y = py * state.components[2].v_samp / state.max_v_samp;
                const cb: i32 = @as(i32, cb_plane[cb_y * cb_w + cb_x]) - 128;
                const cr: i32 = @as(i32, cr_plane[cr_y * cr_w + cr_x]) - 128;

                // ITU-R BT.601 YCbCr → RGB
                const r = yy + ((cr * 359) >> 8);
                const g = yy - ((cb * 88 + cr * 183) >> 8);
                const b = yy + ((cb * 454) >> 8);

                const idx = (py * w + px) * 4;
                rgba[idx + 0] = clampU8(r);
                rgba[idx + 1] = clampU8(g);
                rgba[idx + 2] = clampU8(b);
                rgba[idx + 3] = 255;
            }
        }
    }

    return out.ptr;
}
