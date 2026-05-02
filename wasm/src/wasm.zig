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
///
/// `lanczos3` takes ownership of an [8-byte header][RGBA] buffer, so this
/// thin wrapper allocates one and copies the input bytes into it. Currently
/// not used by the production worker (which goes through image_decode_resize
/// or image_transform), but kept exported for one-off Node-side testing.
export fn image_resize(
    pixels_ptr: [*]const u8,
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
) ?[*]u8 {
    const pixel_bytes = @as(usize, src_width) * @as(usize, src_height) * 4;
    const wrapped = memory.alloc(@intCast(8 + pixel_bytes)) orelse return null;
    std.mem.writeInt(u32, wrapped[0..4], src_width, .little);
    std.mem.writeInt(u32, wrapped[4..8], src_height, .little);
    @memcpy(wrapped[8 .. 8 + pixel_bytes], pixels_ptr[0..pixel_bytes]);
    return resize.lanczos3(wrapped[0 .. 8 + pixel_bytes], src_width, src_height, dst_width, dst_height);
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
///
/// `resize.lanczos3` now takes ownership of the decoded buffer and frees it
/// after the horizontal pass — without that, peak memory for a 4000×3000
/// source resizing to 3840×2880 hit 138 MB and exceeded the 128 MB isolate.
export fn image_decode_resize(
    src_ptr: [*]const u8,
    src_len: u32,
    dst_width: u32,
) ?[*]u8 {
    const decoded = decode.decodeImage(src_ptr, src_len) orelse return null;
    const dec_width = std.mem.readInt(u32, decoded[0..4], .little);
    const dec_height = std.mem.readInt(u32, decoded[4..8], .little);

    // Clamp output to source width, never upscale. Upscaling produces blurry
    // output AND eats memory: 3840×2880 RGBA is 44 MB, plus the encoder's
    // working set, easily pushes the Workers 128 MB isolate cap. Standard
    // image-CDN behavior.
    const clamped_dst_width = if (dst_width == 0 or dst_width > dec_width) dec_width else dst_width;
    const dst_height: u32 = @intCast(@as(u64, dec_height) * clamped_dst_width / dec_width);

    const dec_size = 8 + @as(usize, dec_width) * @as(usize, dec_height) * 4;

    if (clamped_dst_width == dec_width and dst_height == dec_height) {
        return decoded;
    }

    return resize.lanczos3(decoded[0..dec_size], dec_width, dec_height, clamped_dst_width, dst_height);
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
    const decoded = decode.decodeImage(src_ptr, src_len) orelse return null;
    const dec_width = std.mem.readInt(u32, decoded[0..4], .little);
    const dec_height = std.mem.readInt(u32, decoded[4..8], .little);

    // Clamp output to source width, never upscale. Avoids blurry output and
    // keeps the resize+encode working set inside Workers' 128 MB isolate cap.
    const clamped_dst_width = if (dst_width == 0 or dst_width > dec_width) dec_width else dst_width;
    const dst_height: u32 = @intCast(@as(u64, dec_height) * clamped_dst_width / dec_width);

    const dec_size = 8 + @as(usize, dec_width) * @as(usize, dec_height) * 4;

    // Either keep `decoded` if no resize is needed, or hand it to lanczos3
    // which frees it and returns a fresh buffer. `owned_buf` is whichever
    // buffer holds the pixels we hand to the encoder; we free it after.
    var final_pixels: [*]const u8 = undefined;
    var final_w: u32 = undefined;
    var final_h: u32 = undefined;
    var owned_buf: [*]u8 = undefined;
    var owned_size: usize = undefined;

    if (clamped_dst_width != dec_width or dst_height != dec_height) {
        const resized = resize.lanczos3(
            decoded[0..dec_size],
            dec_width,
            dec_height,
            clamped_dst_width,
            dst_height,
        ) orelse return null;
        final_w = std.mem.readInt(u32, resized[0..4], .little);
        final_h = std.mem.readInt(u32, resized[4..8], .little);
        final_pixels = resized + 8;
        owned_buf = resized;
        owned_size = 8 + @as(usize, final_w) * @as(usize, final_h) * 4;
    } else {
        final_pixels = decoded + 8;
        final_w = dec_width;
        final_h = dec_height;
        owned_buf = decoded;
        owned_size = dec_size;
    }

    const result = encode.encodeImage(final_pixels, final_w, final_h, output_format, quality);

    memory.free(owned_buf, @intCast(owned_size));

    return result;
}
