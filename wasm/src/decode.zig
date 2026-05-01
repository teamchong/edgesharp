/// Image decoder: JPEG, PNG → raw RGBA pixels.
/// Pure Zig, no external dependencies, works on wasm32-freestanding.
///
/// Output format: [4 bytes width LE][4 bytes height LE][width*height*4 bytes RGBA]
const std = @import("std");
const mem = @import("memory.zig");
const jpeg = @import("jpeg.zig");

const Format = enum { jpeg, png };

fn detectFormat(src: []const u8) ?Format {
    if (src.len < 4) return null;
    if (src[0] == 0xFF and src[1] == 0xD8 and src[2] == 0xFF) return .jpeg;
    if (src[0] == 0x89 and src[1] == 0x50 and src[2] == 0x4E and src[3] == 0x47) return .png;
    return null;
}

/// Decode compressed image bytes to RGBA pixel buffer.
/// Returns null on unsupported format or decode error.
pub fn decodeImage(src_ptr: [*]const u8, src_len: u32) ?[*]u8 {
    const src = src_ptr[0..src_len];
    const format = detectFormat(src) orelse return null;

    return switch (format) {
        .jpeg => jpeg.decode(src),
        .png => decodePng(src),
    };
}

/// PNG decoder for WASM freestanding.
/// Supports 8-bit RGB, RGBA, grayscale, grayscale+alpha, and indexed color.
/// Non-interlaced only.
fn decodePng(src: []const u8) ?[*]u8 {
    const signature = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
    if (src.len < 8 or !std.mem.eql(u8, src[0..8], &signature)) return null;

    var pos: usize = 8;
    if (pos + 25 > src.len) return null;

    const ihdr_len = std.mem.readInt(u32, src[pos..][0..4], .big);
    _ = ihdr_len;
    pos += 4;

    if (!std.mem.eql(u8, src[pos..][0..4], "IHDR")) return null;
    pos += 4;

    const width = std.mem.readInt(u32, src[pos..][0..4], .big);
    pos += 4;
    const height = std.mem.readInt(u32, src[pos..][0..4], .big);
    pos += 4;

    const bit_depth = src[pos];
    pos += 1;
    const color_type = src[pos];
    pos += 1;
    const compression = src[pos];
    pos += 1;
    const filter_method = src[pos];
    pos += 1;
    const interlace = src[pos];
    pos += 1;

    if (bit_depth != 8 or compression != 0 or filter_method != 0 or interlace != 0) return null;
    // 0=grayscale, 2=RGB, 3=indexed, 4=grayscale+alpha, 6=RGBA
    const channels: u32 = switch (color_type) {
        0 => 1,
        2 => 3,
        3 => 1, // indexed: 1 byte per pixel into palette
        4 => 2,
        6 => 4,
        else => return null,
    };

    pos += 4; // skip IHDR CRC

    // Parse PLTE if present (needed for color_type 3)
    var palette: [256][4]u8 = undefined;
    var has_palette = false;

    // Collect IDAT chunks and find PLTE
    var idat_total: usize = 0;
    var scan_pos = pos;
    while (scan_pos + 12 <= src.len) {
        const chunk_len = std.mem.readInt(u32, src[scan_pos..][0..4], .big);
        const chunk_type = src[scan_pos + 4 ..][0..4];

        if (std.mem.eql(u8, chunk_type, "PLTE")) {
            const plte_data = src[scan_pos + 8 ..][0..chunk_len];
            const num_entries = chunk_len / 3;
            for (0..num_entries) |i| {
                palette[i] = .{ plte_data[i * 3], plte_data[i * 3 + 1], plte_data[i * 3 + 2], 255 };
            }
            has_palette = true;
        }

        if (std.mem.eql(u8, chunk_type, "IDAT")) {
            idat_total += chunk_len;
        }
        scan_pos += 12 + chunk_len;
        if (std.mem.eql(u8, chunk_type, "IEND")) break;
    }

    if (idat_total == 0) return null;
    if (color_type == 3 and !has_palette) return null;

    // Concatenate IDAT data
    const idat_buf = mem.allocSlice(idat_total) orelse return null;
    defer mem.freeSlice(idat_buf);

    var idat_pos: usize = 0;
    scan_pos = pos;
    while (scan_pos + 12 <= src.len) {
        const chunk_len = std.mem.readInt(u32, src[scan_pos..][0..4], .big);
        const chunk_type = src[scan_pos + 4 ..][0..4];
        if (std.mem.eql(u8, chunk_type, "IDAT")) {
            const data = src[scan_pos + 8 ..][0..chunk_len];
            @memcpy(idat_buf[idat_pos..][0..chunk_len], data);
            idat_pos += chunk_len;
        }
        scan_pos += 12 + chunk_len;
        if (std.mem.eql(u8, chunk_type, "IEND")) break;
    }

    // Decompress with zlib
    const stride = width * channels;
    const raw_size = height * (1 + stride);
    const raw_buf = mem.allocSlice(raw_size) orelse return null;
    defer mem.freeSlice(raw_buf);

    // PNG IDAT uses zlib format: 2-byte header + deflate data + 4-byte checksum
    if (idat_buf.len < 2) return null;
    var reader = std.Io.Reader.fixed(idat_buf[2..]); // skip zlib header (CMF + FLG)
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var decompressor = std.compress.flate.Decompress.init(&reader, .raw, &window);
    var writer = std.Io.Writer.fixed(raw_buf);
    const bytes_read = decompressor.reader.streamRemaining(&writer) catch return null;
    if (bytes_read != raw_size) return null;

    // Allocate output RGBA buffer with header
    const pixel_count = width * height;
    const out_size = 8 + pixel_count * 4;
    const out = mem.allocSlice(out_size) orelse return null;

    std.mem.writeInt(u32, out[0..4], width, .little);
    std.mem.writeInt(u32, out[4..8], height, .little);
    const rgba = out[8..];

    // Unfilter and convert to RGBA
    var prev_row: ?[]const u8 = null;

    for (0..height) |y| {
        const row_start = y * (1 + stride);
        const filter_type = raw_buf[row_start];
        const row = raw_buf[row_start + 1 ..][0..stride];

        unfilterRow(filter_type, row, prev_row, channels);

        for (0..width) |x| {
            const dst_idx = (y * width + x) * 4;
            switch (color_type) {
                0 => { // Grayscale
                    const v = row[x];
                    rgba[dst_idx + 0] = v;
                    rgba[dst_idx + 1] = v;
                    rgba[dst_idx + 2] = v;
                    rgba[dst_idx + 3] = 255;
                },
                2 => { // RGB
                    rgba[dst_idx + 0] = row[x * 3 + 0];
                    rgba[dst_idx + 1] = row[x * 3 + 1];
                    rgba[dst_idx + 2] = row[x * 3 + 2];
                    rgba[dst_idx + 3] = 255;
                },
                3 => { // Indexed
                    const entry = palette[row[x]];
                    rgba[dst_idx + 0] = entry[0];
                    rgba[dst_idx + 1] = entry[1];
                    rgba[dst_idx + 2] = entry[2];
                    rgba[dst_idx + 3] = entry[3];
                },
                4 => { // Grayscale + Alpha
                    const v = row[x * 2];
                    rgba[dst_idx + 0] = v;
                    rgba[dst_idx + 1] = v;
                    rgba[dst_idx + 2] = v;
                    rgba[dst_idx + 3] = row[x * 2 + 1];
                },
                6 => { // RGBA
                    rgba[dst_idx + 0] = row[x * 4 + 0];
                    rgba[dst_idx + 1] = row[x * 4 + 1];
                    rgba[dst_idx + 2] = row[x * 4 + 2];
                    rgba[dst_idx + 3] = row[x * 4 + 3];
                },
                else => {},
            }
        }

        prev_row = row;
    }

    return out.ptr;
}

fn unfilterRow(filter_type: u8, row: []u8, prev_row: ?[]const u8, bpp: u32) void {
    switch (filter_type) {
        0 => {},
        1 => { // Sub
            for (bpp..row.len) |i| {
                row[i] = row[i] +% row[i - bpp];
            }
        },
        2 => { // Up
            if (prev_row) |prev| {
                for (0..row.len) |i| {
                    row[i] = row[i] +% prev[i];
                }
            }
        },
        3 => { // Average
            for (0..row.len) |i| {
                const a: u16 = if (i >= bpp) row[i - bpp] else 0;
                const b: u16 = if (prev_row) |prev| prev[i] else 0;
                row[i] = row[i] +% @as(u8, @intCast((a + b) / 2));
            }
        },
        4 => { // Paeth
            for (0..row.len) |i| {
                const a: i16 = if (i >= bpp) @as(i16, row[i - bpp]) else 0;
                const b: i16 = if (prev_row) |prev| @as(i16, prev[i]) else 0;
                const c: i16 = if (i >= bpp and prev_row != null) @as(i16, prev_row.?[i - bpp]) else 0;
                row[i] = row[i] +% paethPredictor(a, b, c);
            }
        },
        else => {},
    }
}

fn paethPredictor(a: i16, b: i16, c: i16) u8 {
    const p = a + b - c;
    const pa = if (p > a) p - a else a - p;
    const pb = if (p > b) p - b else b - p;
    const pc = if (p > c) p - c else c - p;
    if (pa <= pb and pa <= pc) return @intCast(@as(u16, @bitCast(a)));
    if (pb <= pc) return @intCast(@as(u16, @bitCast(b)));
    return @intCast(@as(u16, @bitCast(c)));
}
