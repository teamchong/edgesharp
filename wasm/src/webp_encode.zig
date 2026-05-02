/// WebP encoding via statically linked libwebp (C).
/// Calls our tiny C wrapper (webp_advanced.c) which uses libwebp's
/// WebPConfig/WebPPicture API with method=1, ~2× faster encode than the
/// simple `WebPEncodeRGBA` (which is hardcoded to method=4) at ~5-8% larger
/// output. CDN traffic re-uses cached bytes so the speed win compounds.
const std = @import("std");
const mem = @import("memory.zig");

// Encoder method: 0 (fastest) to 6 (slowest, smallest output).
// libwebp's default in the simple API is 4. We pick 1 for "fast first encode,
// cache the result forever", the speed/size cliff between 4 and 1 is mild,
// the cliff between 1 and 0 is sharper.
const WEBP_METHOD: c_int = 1;

// Opaque WebPMemoryWriter buffer. Sized at runtime via the C helper to avoid
// hardcoding the libwebp struct layout in Zig.
extern fn edgesharp_webp_writer_size() usize;
extern fn edgesharp_webp_writer_clear(writer: [*]u8) void;

extern fn edgesharp_webp_encode(
    rgba: [*]const u8,
    width: c_int,
    height: c_int,
    stride: c_int,
    quality: f32,
    method: c_int,
    output_ptr: *[*]u8,
    writer: [*]u8,
) usize;

/// Encode raw RGBA pixels to WebP.
/// Returns a newly allocated buffer: [4 bytes length LE][encoded WebP bytes]
/// Caller must free via mem.freeSlice.
pub fn encodeWebP(
    pixels_ptr: [*]const u8,
    width: u32,
    height: u32,
    quality: u8,
) ?[*]u8 {
    const stride: c_int = @intCast(width * 4);

    // Stack-allocate the WebPMemoryWriter (its size is small, ~32 bytes -
    // and known at runtime via the helper). Zig can't size a stack buffer
    // from a runtime call, so we allocate from our WASM arena instead.
    const writer_size = edgesharp_webp_writer_size();
    const writer_buf = mem.allocSlice(writer_size) orelse return null;
    defer mem.freeSlice(writer_buf);

    var output_ptr: [*]u8 = undefined;
    const encoded_size = edgesharp_webp_encode(
        pixels_ptr,
        @intCast(width),
        @intCast(height),
        stride,
        @floatFromInt(quality),
        WEBP_METHOD,
        &output_ptr,
        writer_buf.ptr,
    );

    if (encoded_size == 0) return null;

    // libwebp owns output_ptr until WebPMemoryWriterClear; copy to our arena
    // so we can free libwebp's buffer immediately and return our own.
    const out_size = 4 + encoded_size;
    const out = mem.allocSlice(out_size) orelse {
        edgesharp_webp_writer_clear(writer_buf.ptr);
        return null;
    };

    std.mem.writeInt(u32, out[0..4], @intCast(encoded_size), .little);
    @memcpy(out[4..][0..encoded_size], output_ptr[0..encoded_size]);

    edgesharp_webp_writer_clear(writer_buf.ptr);

    return out.ptr;
}
