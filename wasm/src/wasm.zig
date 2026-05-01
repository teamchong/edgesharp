/// edgesharp WASM entry point.
/// Exports image decode, resize (Lanczos3 SIMD), and encode functions
/// to the JavaScript host.
const std = @import("std");
const resize = @import("resize.zig");
const decode = @import("decode.zig");
const encode = @import("encode.zig");
const memory = @import("memory.zig");

// libc glue for miniz (C deflate library linked into WASM)
comptime {
    _ = @import("libc_glue.zig");
}

// ── Memory management (exported to JS host) ──

export fn wasm_alloc(len: u32) ?[*]u8 {
    return memory.alloc(len);
}

export fn wasm_free(ptr: [*]u8, len: u32) void {
    memory.free(ptr, len);
}

// ── Image operations ──

/// Decode JPEG/PNG/WebP from compressed bytes into raw RGBA pixels.
/// Returns pointer to: [4 bytes width][4 bytes height][width*height*4 bytes RGBA]
/// Caller must free the returned buffer.
export fn image_decode(src_ptr: [*]const u8, src_len: u32) ?[*]u8 {
    return decode.decodeImage(src_ptr, src_len);
}

/// Resize raw RGBA pixels using Lanczos3 with SIMD acceleration.
/// Input: [width*height*4 bytes RGBA]
/// Returns pointer to: [4 bytes new_width][4 bytes new_height][new_width*new_height*4 bytes RGBA]
export fn image_resize(
    pixels_ptr: [*]const u8,
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
) ?[*]u8 {
    return resize.lanczos3(pixels_ptr, src_width, src_height, dst_width, dst_height);
}

/// Encode raw RGBA pixels to the specified format.
/// format: 0 = JPEG, 1 = PNG, 2 = WebP
/// Returns pointer to: [4 bytes length][length bytes encoded data]
export fn image_encode(
    pixels_ptr: [*]const u8,
    width: u32,
    height: u32,
    format: u8,
    quality: u8,
) ?[*]u8 {
    return encode.encodeImage(pixels_ptr, width, height, format, quality);
}

/// Decode + resize, no encode. Returns the resized pixel buffer prefixed with
/// [4 bytes width LE][4 bytes height LE][width*height*4 bytes RGBA].
/// Used by the AVIF path: the JS-side libavif encoder receives raw RGBA from
/// here so we don't pay PNG/WebP encode + decode round-tripping.
export fn image_decode_resize(
    src_ptr: [*]const u8,
    src_len: u32,
    dst_width: u32,
) ?[*]u8 {
    const decoded = decode.decodeImage(src_ptr, src_len) orelse return null;
    const dec_width = std.mem.readInt(u32, decoded[0..4], .little);
    const dec_height = std.mem.readInt(u32, decoded[4..8], .little);
    const pixels = decoded + 8;

    const dst_height: u32 = if (dst_width > 0)
        @intCast(@as(u64, dec_height) * dst_width / dec_width)
    else
        dec_height;
    const actual_dst_width = if (dst_width > 0) dst_width else dec_width;

    if (actual_dst_width == dec_width and dst_height == dec_height) {
        return decoded;
    }

    const resized = resize.lanczos3(pixels, dec_width, dec_height, actual_dst_width, dst_height);
    const dec_size = 8 + @as(usize, dec_width) * @as(usize, dec_height) * 4;
    memory.free(decoded, dec_size);
    return resized;
}

/// Combined pipeline: decode → resize → encode in one call.
/// Minimizes memory allocations and copies.
export fn image_transform(
    src_ptr: [*]const u8,
    src_len: u32,
    dst_width: u32,
    output_format: u8,
    quality: u8,
) ?[*]u8 {
    // Decode
    const decoded = decode.decodeImage(src_ptr, src_len) orelse return null;
    const dec_width = std.mem.readInt(u32, decoded[0..4], .little);
    const dec_height = std.mem.readInt(u32, decoded[4..8], .little);
    const pixels = decoded + 8;

    // Calculate destination height maintaining aspect ratio
    const dst_height: u32 = if (dst_width > 0)
        @intCast(@as(u64, dec_height) * dst_width / dec_width)
    else
        dec_height;

    const actual_dst_width = if (dst_width > 0) dst_width else dec_width;

    // Resize (skip if same dimensions)
    var final_pixels = pixels;
    var final_w = dec_width;
    var final_h = dec_height;
    var resized_buf: ?[*]u8 = null;

    if (actual_dst_width != dec_width or dst_height != dec_height) {
        resized_buf = resize.lanczos3(pixels, dec_width, dec_height, actual_dst_width, dst_height);
        if (resized_buf) |buf| {
            final_w = std.mem.readInt(u32, buf[0..4], .little);
            final_h = std.mem.readInt(u32, buf[4..8], .little);
            final_pixels = buf + 8;
        }
    }

    // Encode
    const result = encode.encodeImage(final_pixels, final_w, final_h, output_format, quality);

    // Free intermediate buffers
    const dec_size = 8 + dec_width * dec_height * 4;
    memory.free(decoded, dec_size);
    if (resized_buf) |buf| {
        const res_size = 8 + final_w * final_h * 4;
        memory.free(buf, res_size);
    }

    return result;
}
