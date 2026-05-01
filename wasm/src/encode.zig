/// Image encoder: raw RGBA pixels → JPEG or PNG.
/// JPEG: pure Zig baseline DCT encoder.
/// PNG: zlib compression via statically linked miniz (C).
///
/// Output format: [4 bytes length LE][length bytes encoded data]
const std = @import("std");
const mem = @import("memory.zig");
const deflate = @import("deflate.zig");
const webp = @import("webp_encode.zig");

pub const OutputFormat = enum(u8) {
    jpeg = 0,
    png = 1,
    webp = 2,
};

/// Encode raw RGBA pixels into the specified format.
/// Returns null on encode error.
pub fn encodeImage(
    pixels_ptr: [*]const u8,
    width: u32,
    height: u32,
    format: u8,
    quality: u8,
) ?[*]u8 {
    const output_format = std.enums.fromInt(OutputFormat, format) orelse return null;
    const pixel_count = @as(usize, width) * @as(usize, height);
    const rgba = pixels_ptr[0 .. pixel_count * 4];

    return switch (output_format) {
        .png => encodePng(rgba, width, height),
        .jpeg => encodeJpeg(rgba, width, height, quality),
        .webp => webp.encodeWebP(pixels_ptr, width, height, quality),
    };
}

// ── PNG Encoder ──

fn encodePng(rgba: []const u8, width: u32, height: u32) ?[*]u8 {
    const stride = width * 4;
    const raw_size = height * (1 + stride);

    // Build raw filtered data (filter type 0 = None, optimal for RGBA with high entropy)
    const raw = mem.allocSlice(raw_size) orelse return null;
    defer mem.freeSlice(raw);

    for (0..height) |y| {
        const row_start = y * (1 + stride);
        raw[row_start] = 0; // filter type: None
        @memcpy(raw[row_start + 1 ..][0..stride], rgba[y * stride ..][0..stride]);
    }

    // Compress with zlib
    // Compress with miniz (zlib format: 2-byte header + deflate + 4-byte Adler-32)
    const compressed_data = deflate.compressZlib(raw) orelse return null;
    defer mem.freeSlice(compressed_data);
    const comp_len = compressed_data.len;

    // Signature(8) + IHDR(25) + IDAT(12+comp_len) + IEND(12)
    const total_size = 8 + 25 + 12 + comp_len + 12;
    const out_size = 4 + total_size;
    const out = mem.allocSlice(out_size) orelse return null;

    std.mem.writeInt(u32, out[0..4], @intCast(total_size), .little);
    var pos: usize = 4;

    const sig = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
    @memcpy(out[pos..][0..8], &sig);
    pos += 8;

    pos += writeChunk(out[pos..], "IHDR", &ihdrData(width, height));
    pos += writeChunk(out[pos..], "IDAT", compressed_data);
    pos += writeChunk(out[pos..], "IEND", &[_]u8{});

    return out.ptr;
}

fn ihdrData(width: u32, height: u32) [13]u8 {
    var data: [13]u8 = undefined;
    std.mem.writeInt(u32, data[0..4], width, .big);
    std.mem.writeInt(u32, data[4..8], height, .big);
    data[8] = 8; // bit depth
    data[9] = 6; // color type: RGBA
    data[10] = 0; // compression
    data[11] = 0; // filter
    data[12] = 0; // interlace
    return data;
}

fn writeChunk(dest: []u8, chunk_type: *const [4]u8, data: []const u8) usize {
    const len: u32 = @intCast(data.len);
    std.mem.writeInt(u32, dest[0..4], len, .big);
    @memcpy(dest[4..8], chunk_type);
    if (data.len > 0) {
        @memcpy(dest[8..][0..data.len], data);
    }
    var crc = std.hash.Crc32.init();
    crc.update(chunk_type);
    crc.update(data);
    std.mem.writeInt(u32, dest[8 + data.len ..][0..4], crc.final(), .big);
    return 12 + data.len;
}

// ── JPEG Encoder ──
// Baseline sequential DCT, YCbCr 4:4:4, Huffman coding with
// standard Annex K tables, quality-scaled quantization.

const std_lum_quant = [64]u8{
    16, 11, 10, 16, 24,  40,  51,  61,
    12, 12, 14, 19, 26,  58,  60,  55,
    14, 13, 16, 24, 40,  57,  69,  56,
    14, 17, 22, 29, 51,  87,  80,  62,
    18, 22, 37, 56, 68,  109, 103, 77,
    24, 35, 55, 64, 81,  104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
};

const std_chrom_quant = [64]u8{
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
};

const zigzag_order = [64]u8{
    0,  1,  8,  16, 9,  2,  3,  10,
    17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
};

// Standard Huffman tables (JPEG Annex K)
const dc_lum_bits = [16]u8{ 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0 };
const dc_lum_vals = [12]u8{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 };
const dc_chrom_bits = [16]u8{ 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0 };
const dc_chrom_vals = [12]u8{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 };

const ac_lum_bits = [16]u8{ 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d };
const ac_chrom_bits = [16]u8{ 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77 };

const ac_lum_vals = [162]u8{
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61,
    0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52,
    0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25,
    0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83,
    0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
    0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3,
    0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
    0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
};

const ac_chrom_vals = [162]u8{
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61,
    0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33,
    0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18,
    0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
    0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63,
    0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
    0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
    0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
    0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
};

const EncHuffCode = struct {
    code: u16,
    size: u8,
};

fn buildEncHuffTable(bits: [16]u8, vals: []const u8) [256]EncHuffCode {
    var table = [_]EncHuffCode{.{ .code = 0, .size = 0 }} ** 256;
    var code: u16 = 0;
    var idx: usize = 0;

    for (0..16) |len| {
        for (0..bits[len]) |_| {
            if (idx < vals.len) {
                table[vals[idx]] = .{ .code = code, .size = @intCast(len + 1) };
                idx += 1;
            }
            code += 1;
        }
        code <<= 1;
    }
    return table;
}

fn scaleQuantTable(base: [64]u8, quality_param: u8) [64]u8 {
    const q: u32 = if (quality_param < 1) 1 else if (quality_param > 100) 100 else quality_param;
    const scale: u32 = if (q < 50) 5000 / q else 200 - q * 2;
    var result: [64]u8 = undefined;
    for (0..64) |i| {
        var val = (@as(u32, base[i]) * scale + 50) / 100;
        if (val < 1) val = 1;
        if (val > 255) val = 255;
        result[i] = @intCast(val);
    }
    return result;
}

const BitWriter = struct {
    data: []u8,
    pos: usize,
    bits: u32,
    count: u8,

    fn init(data: []u8) BitWriter {
        return .{ .data = data, .pos = 0, .bits = 0, .count = 0 };
    }

    fn writeBits(self: *BitWriter, code: u16, size: u8) void {
        self.bits = (self.bits << @as(u5, @intCast(size))) | code;
        self.count += size;
        while (self.count >= 8) {
            self.count -= 8;
            const byte: u8 = @intCast((self.bits >> @as(u5, @intCast(self.count))) & 0xFF);
            self.emitByte(byte);
        }
    }

    fn emitByte(self: *BitWriter, b: u8) void {
        if (self.pos < self.data.len) {
            self.data[self.pos] = b;
            self.pos += 1;
            if (b == 0xFF and self.pos < self.data.len) {
                self.data[self.pos] = 0x00;
                self.pos += 1;
            }
        }
    }

    fn flush(self: *BitWriter) void {
        if (self.count > 0) {
            self.writeBits(@intCast((@as(u16, 1) << @intCast(8 - self.count)) - 1), 8 - self.count);
        }
    }

    fn writeRaw(self: *BitWriter, data: []const u8) void {
        for (data) |b| {
            if (self.pos < self.data.len) {
                self.data[self.pos] = b;
                self.pos += 1;
            }
        }
    }
};

fn fdct(block: *[64]f32) void {
    for (0..8) |i| {
        fdct1d(block[i * 8 ..][0..8]);
    }
    for (0..8) |j| {
        var col: [8]f32 = undefined;
        for (0..8) |i| col[i] = block[i * 8 + j];
        fdct1d(&col);
        for (0..8) |i| block[i * 8 + j] = col[i];
    }
}

fn fdct1d(d: *[8]f32) void {
    const c1: f32 = 0.980785280;
    const c2: f32 = 0.923879533;
    const c3: f32 = 0.831469612;
    const c5: f32 = 0.555570233;
    const c6: f32 = 0.382683432;
    const c7: f32 = 0.195090322;

    const s0 = d[0] + d[7];
    const s1 = d[1] + d[6];
    const s2 = d[2] + d[5];
    const s3 = d[3] + d[4];
    const s4 = d[3] - d[4];
    const s5 = d[2] - d[5];
    const s6 = d[1] - d[6];
    const s7 = d[0] - d[7];

    const e0 = s0 + s3;
    const e1 = s1 + s2;
    const e2 = s1 - s2;
    const e3 = s0 - s3;

    d[0] = (e0 + e1) * 0.353553391;
    d[4] = (e0 - e1) * 0.353553391;
    d[2] = e3 * c2 * 0.5 + e2 * c6 * 0.5;
    d[6] = e3 * c6 * 0.5 - e2 * c2 * 0.5;

    d[1] = (s7 * c1 + s6 * c3 + s5 * c5 + s4 * c7) * 0.5;
    d[3] = (s7 * c3 - s6 * c7 - s5 * c1 - s4 * c5) * 0.5;
    d[5] = (s7 * c5 - s6 * c1 + s5 * c7 + s4 * c3) * 0.5;
    d[7] = (s7 * c7 - s6 * c5 + s5 * c3 - s4 * c1) * 0.5;
}

fn encodeBlock(
    writer: *BitWriter,
    block: *[64]f32,
    quant: [64]u8,
    dc_pred: *i32,
    dc_table: [256]EncHuffCode,
    ac_table: [256]EncHuffCode,
) void {
    fdct(block);

    var qblock: [64]i32 = undefined;
    for (0..64) |i| {
        const zz = zigzag_order[i];
        qblock[i] = @intFromFloat(@round(block[zz] / @as(f32, @floatFromInt(quant[i]))));
    }

    // DC coefficient
    const dc_diff = qblock[0] - dc_pred.*;
    dc_pred.* = qblock[0];

    const dc_size = bitSize(dc_diff);
    const dc_huff = dc_table[dc_size];
    writer.writeBits(dc_huff.code, dc_huff.size);
    if (dc_size > 0) {
        const dc_val: u16 = if (dc_diff < 0)
            @intCast(@as(i32, dc_diff) + (@as(i32, 1) << @intCast(dc_size)) - 1)
        else
            @intCast(dc_diff);
        writer.writeBits(dc_val, dc_size);
    }

    // AC coefficients
    var zero_run: u8 = 0;
    for (1..64) |i| {
        if (qblock[i] == 0) {
            zero_run += 1;
            continue;
        }
        while (zero_run >= 16) {
            const zrl = ac_table[0xF0];
            writer.writeBits(zrl.code, zrl.size);
            zero_run -= 16;
        }
        const ac_size = bitSize(qblock[i]);
        const rs = (zero_run << 4) | ac_size;
        const ac_huff = ac_table[rs];
        writer.writeBits(ac_huff.code, ac_huff.size);
        const ac_val: u16 = if (qblock[i] < 0)
            @intCast(@as(i32, qblock[i]) + (@as(i32, 1) << @intCast(ac_size)) - 1)
        else
            @intCast(qblock[i]);
        writer.writeBits(ac_val, ac_size);
        zero_run = 0;
    }

    if (zero_run > 0) {
        const eob = ac_table[0x00];
        writer.writeBits(eob.code, eob.size);
    }
}

fn bitSize(val: i32) u8 {
    if (val == 0) return 0;
    const abs_val: u32 = @intCast(if (val < 0) -val else val);
    return @intCast(32 - @clz(abs_val));
}

fn encodeJpeg(rgba: []const u8, width: u32, height: u32, quality: u8) ?[*]u8 {
    const lum_quant = scaleQuantTable(std_lum_quant, quality);
    const chrom_quant = scaleQuantTable(std_chrom_quant, quality);

    const dc_lum_enc = buildEncHuffTable(dc_lum_bits, &dc_lum_vals);
    const dc_chrom_enc = buildEncHuffTable(dc_chrom_bits, &dc_chrom_vals);
    const ac_lum_enc = buildEncHuffTable(ac_lum_bits, &ac_lum_vals);
    const ac_chrom_enc = buildEncHuffTable(ac_chrom_bits, &ac_chrom_vals);

    const max_out = 1024 + @as(usize, width) * height * 4;
    const buf = mem.allocSlice(max_out) orelse return null;

    var writer = BitWriter.init(buf[4..]);

    // SOI
    writer.writeRaw(&[_]u8{ 0xFF, 0xD8 });

    // APP0 (JFIF)
    writer.writeRaw(&[_]u8{
        0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46,
        0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
        0x00, 0x00,
    });

    writeDQT(&writer, 0, lum_quant);
    writeDQT(&writer, 1, chrom_quant);
    writeSOF0(&writer, width, height);
    writeDHT(&writer, 0x00, dc_lum_bits, &dc_lum_vals);
    writeDHT(&writer, 0x10, ac_lum_bits, &ac_lum_vals);
    writeDHT(&writer, 0x01, dc_chrom_bits, &dc_chrom_vals);
    writeDHT(&writer, 0x11, ac_chrom_bits, &ac_chrom_vals);

    // SOS
    writer.writeRaw(&[_]u8{
        0xFF, 0xDA, 0x00, 0x0C, 0x03,
        0x01, 0x00, // Y: DC table 0, AC table 0
        0x02, 0x11, // Cb: DC table 1, AC table 1
        0x03, 0x11, // Cr: DC table 1, AC table 1
        0x00, 0x3F, 0x00,
    });

    // Encode MCUs — 4:4:4 YCbCr (full chroma resolution, no subsampling)
    var dc_y: i32 = 0;
    var dc_cb: i32 = 0;
    var dc_cr: i32 = 0;

    var mcu_y: u32 = 0;
    while (mcu_y < height) : (mcu_y += 8) {
        var mcu_x: u32 = 0;
        while (mcu_x < width) : (mcu_x += 8) {
            var y_block: [64]f32 = undefined;
            var cb_block: [64]f32 = undefined;
            var cr_block: [64]f32 = undefined;

            for (0..8) |by| {
                for (0..8) |bx| {
                    const px = @min(mcu_x + bx, width - 1);
                    const py = @min(mcu_y + by, height - 1);
                    const idx = (py * width + px) * 4;

                    const r: f32 = @floatFromInt(rgba[idx]);
                    const g: f32 = @floatFromInt(rgba[idx + 1]);
                    const b_val: f32 = @floatFromInt(rgba[idx + 2]);

                    const bidx = by * 8 + bx;
                    y_block[bidx] = 0.299 * r + 0.587 * g + 0.114 * b_val - 128.0;
                    cb_block[bidx] = -0.168736 * r - 0.331264 * g + 0.5 * b_val;
                    cr_block[bidx] = 0.5 * r - 0.418688 * g - 0.081312 * b_val;
                }
            }

            encodeBlock(&writer, &y_block, lum_quant, &dc_y, dc_lum_enc, ac_lum_enc);
            encodeBlock(&writer, &cb_block, chrom_quant, &dc_cb, dc_chrom_enc, ac_chrom_enc);
            encodeBlock(&writer, &cr_block, chrom_quant, &dc_cr, dc_chrom_enc, ac_chrom_enc);
        }
    }

    writer.flush();
    writer.writeRaw(&[_]u8{ 0xFF, 0xD9 }); // EOI

    const total_len: u32 = @intCast(writer.pos);
    std.mem.writeInt(u32, buf[0..4], total_len, .little);

    const final_size = 4 + writer.pos;
    const result = mem.allocSlice(final_size) orelse {
        mem.freeSlice(buf);
        return null;
    };
    @memcpy(result, buf[0..final_size]);
    mem.freeSlice(buf);

    return result.ptr;
}

fn writeDQT(writer: *BitWriter, table_id: u8, quant: [64]u8) void {
    writer.writeRaw(&[_]u8{ 0xFF, 0xDB, 0x00, 0x43, table_id });
    for (0..64) |i| {
        writer.writeRaw(&[_]u8{quant[zigzag_order[i]]});
    }
}

fn writeSOF0(writer: *BitWriter, width: u32, height: u32) void {
    var sof: [19]u8 = undefined;
    sof[0] = 0xFF;
    sof[1] = 0xC0;
    std.mem.writeInt(u16, sof[2..4], 17, .big);
    sof[4] = 8;
    std.mem.writeInt(u16, sof[5..7], @intCast(height), .big);
    std.mem.writeInt(u16, sof[7..9], @intCast(width), .big);
    sof[9] = 3;
    sof[10] = 1;
    sof[11] = 0x11; // Y: 1×1
    sof[12] = 0;
    sof[13] = 2;
    sof[14] = 0x11; // Cb: 1×1
    sof[15] = 1;
    sof[16] = 3;
    sof[17] = 0x11; // Cr: 1×1
    sof[18] = 1;
    writer.writeRaw(&sof);
}

fn writeDHT(writer: *BitWriter, class_and_id: u8, bits: [16]u8, vals: []const u8) void {
    var total: u16 = 0;
    for (bits) |b| total += b;
    const length: u16 = 2 + 1 + 16 + total;

    writer.writeRaw(&[_]u8{ 0xFF, 0xC4 });
    var len_bytes: [2]u8 = undefined;
    std.mem.writeInt(u16, &len_bytes, length, .big);
    writer.writeRaw(&len_bytes);
    writer.writeRaw(&[_]u8{class_and_id});
    writer.writeRaw(&bits);
    writer.writeRaw(vals[0..total]);
}
