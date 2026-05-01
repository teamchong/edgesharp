/// Deflate/zlib compression via miniz (statically linked C).
/// Provides zlib-format output (2-byte header + deflate + 4-byte Adler-32).
const std = @import("std");
const mem = @import("memory.zig");

// Miniz C API declarations (linked at build time, no @cImport needed)
const MZ_OK: c_int = 0;
const MZ_DEFAULT_COMPRESSION: c_int = 6;

const mz_ulong = c_ulong;

const mz_stream = extern struct {
    next_in: ?[*]const u8 = null,
    avail_in: c_uint = 0,
    total_in: mz_ulong = 0,
    next_out: ?[*]u8 = null,
    avail_out: c_uint = 0,
    total_out: mz_ulong = 0,
    msg: ?[*:0]const u8 = null,
    state: ?*anyopaque = null,
    zalloc: ?*anyopaque = null,
    zfree: ?*anyopaque = null,
    @"opaque": ?*anyopaque = null,
    data_type: c_int = 0,
    adler: mz_ulong = 0,
    reserved: mz_ulong = 0,
};

extern fn mz_compress2(
    pDest: [*]u8,
    pDest_len: *mz_ulong,
    pSource: [*]const u8,
    source_len: mz_ulong,
    level: c_int,
) c_int;

extern fn mz_compressBound(source_len: mz_ulong) mz_ulong;

/// Compress data using zlib format (deflate + zlib header/footer).
/// Returns a newly allocated buffer: caller must free via mem.freeSlice.
/// Returns null on compression failure.
pub fn compressZlib(input: []const u8) ?[]u8 {
    var dest_len: mz_ulong = mz_compressBound(@intCast(input.len));
    const out = mem.allocSlice(@intCast(dest_len)) orelse return null;

    const status = mz_compress2(
        out.ptr,
        &dest_len,
        input.ptr,
        @intCast(input.len),
        MZ_DEFAULT_COMPRESSION,
    );

    if (status != MZ_OK) {
        mem.freeSlice(out);
        return null;
    }

    return out[0..@intCast(dest_len)];
}
