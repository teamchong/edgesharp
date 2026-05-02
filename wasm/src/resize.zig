/// Lanczos3 image resizer with WASM Relaxed SIMD acceleration.
///
/// Uses separable 2-pass approach:
///   1. Horizontal pass (resize width, SIMD across columns)
///   2. Vertical pass (resize height, SIMD across rows)
///
/// Optimizations:
///   - Lanczos weight tables precomputed once per pass (was: per row/column).
///     Eliminates ~99% of sin() calls, weights only depend on output index + ratio.
///   - Relaxed FMA (f32x4.relaxed_madd) for the convolution multiply-accumulate.
///   - Integer-math premultiply/unpremultiply (no float, no @round).
const std = @import("std");
const math = std.math;
const mem = @import("memory.zig");

const Vec4 = @Vector(4, f32);
const LANCZOS_A: f32 = 3.0; // Lanczos window size (a=3, matches Sharp/libvips)

/// Lanczos3 kernel: sinc(x) * sinc(x/a)
fn lanczosWeight(x: f32) f32 {
    if (x == 0.0) return 1.0;
    if (@abs(x) >= LANCZOS_A) return 0.0;
    const pi_x = math.pi * x;
    const pi_x_a = pi_x / LANCZOS_A;
    return (math.sin(pi_x) / pi_x) * (math.sin(pi_x_a) / pi_x_a);
}

/// Relaxed FMA: a * b + c in one instruction on supported hardware.
/// Falls back to separate mul + add on platforms without FMA.
inline fn fma4(a: Vec4, b: Vec4, c: Vec4) Vec4 {
    return @mulAdd(Vec4, a, b, c);
}

/// Precomputed weights for one resize pass. Layout:
///   weights[out_idx * window_size + k] = weight for k-th tap of out_idx
///   start[out_idx]                     = first source index for out_idx (clamped)
///   norm[out_idx]                      = 1.0 / sum(weights for out_idx) (or 0 if degenerate)
const Filter = struct {
    weights: []f32,
    starts: []i32,
    norms: []f32,
    window: u32,
};

fn buildFilter(src_len: u32, dst_len: u32) ?Filter {
    const ratio: f32 = @as(f32, @floatFromInt(src_len)) / @as(f32, @floatFromInt(dst_len));
    const scale = @max(ratio, 1.0);
    const filter_radius = LANCZOS_A * scale;
    const window: u32 = @intFromFloat(@ceil(filter_radius * 2.0 + 1.0));

    const weights_bytes = @as(usize, dst_len) * window * @sizeOf(f32);
    const starts_bytes = @as(usize, dst_len) * @sizeOf(i32);
    const norms_bytes = @as(usize, dst_len) * @sizeOf(f32);

    const wbuf = mem.allocSlice(weights_bytes) orelse return null;
    const sbuf = mem.allocSlice(starts_bytes) orelse {
        mem.freeSlice(wbuf);
        return null;
    };
    const nbuf = mem.allocSlice(norms_bytes) orelse {
        mem.freeSlice(wbuf);
        mem.freeSlice(sbuf);
        return null;
    };

    const weights: []f32 = @as([*]f32, @ptrCast(@alignCast(wbuf.ptr)))[0 .. @as(usize, dst_len) * window];
    const starts: []i32 = @as([*]i32, @ptrCast(@alignCast(sbuf.ptr)))[0..dst_len];
    const norms: []f32 = @as([*]f32, @ptrCast(@alignCast(nbuf.ptr)))[0..dst_len];

    const inv_scale: f32 = 1.0 / scale;

    var x: u32 = 0;
    while (x < dst_len) : (x += 1) {
        const center: f32 = (@as(f32, @floatFromInt(x)) + 0.5) * ratio - 0.5;
        const start: i32 = @as(i32, @intFromFloat(@ceil(center - filter_radius)));
        starts[x] = start;

        var sum: f32 = 0.0;
        var k: u32 = 0;
        while (k < window) : (k += 1) {
            const sx = start + @as(i32, @intCast(k));
            const w = lanczosWeight((center - @as(f32, @floatFromInt(sx))) * inv_scale);
            weights[x * window + k] = w;
            sum += w;
        }
        norms[x] = if (sum > 0.0) 1.0 / sum else 0.0;
    }

    return .{ .weights = weights, .starts = starts, .norms = norms, .window = window };
}

fn freeFilter(f: Filter) void {
    const wbytes = std.mem.sliceAsBytes(f.weights);
    const sbytes = std.mem.sliceAsBytes(f.starts);
    const nbytes = std.mem.sliceAsBytes(f.norms);
    mem.freeSlice(wbytes);
    mem.freeSlice(sbytes);
    mem.freeSlice(nbytes);
}

/// Resize RGBA pixels using separable Lanczos3.
///
/// Takes ownership of `decoded`, an [8-byte header][src_w*src_h*4 bytes RGBA]
/// buffer. This function frees `decoded` itself before allocating the output,
/// so the caller MUST NOT free it. Returning ownership of the decoded buffer
/// to the resizer lets us:
///
///   1. Premultiply alpha in-place inside the source buffer (no separate
///      48 MB `premul` allocation).
///   2. Free the source buffer immediately after the horizontal pass, before
///      we allocate the output. Without this, peak memory for a
///      4000×3000 → 3840×2880 resize would hold src + tmp + out = 138 MB,
///      which exceeds the Workers 128 MB isolate budget. With it, peak is
///      94 MB during horizontalPass and 90 MB during verticalPass.
///
/// Returns: pointer to [4 bytes dst_w][4 bytes dst_h][dst_w*dst_h*4 bytes RGBA].
/// On any failure the function frees `decoded` and returns null.
pub fn lanczos3(
    decoded: []u8,
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) ?[*]u8 {
    if (src_w == 0 or src_h == 0 or dst_w == 0 or dst_h == 0) {
        mem.freeSlice(decoded);
        return null;
    }

    // Premultiply alpha in-place in the decoded RGBA region. Same effect as
    // the old separate-buffer premultiply (Sharp/libvips do this to avoid
    // color fringing at transparent edges), without the duplicate allocation.
    const pixels = decoded[8..];
    premultiplyAlphaInPlace(pixels);

    // Allocate intermediate buffer (horizontal pass result: dst_w × src_h).
    const tmp_size = @as(usize, dst_w) * @as(usize, src_h) * 4;
    const tmp = mem.allocSlice(tmp_size) orelse {
        mem.freeSlice(decoded);
        return null;
    };

    const h_filter = buildFilter(src_w, dst_w) orelse {
        mem.freeSlice(tmp);
        mem.freeSlice(decoded);
        return null;
    };

    horizontalPass(pixels, tmp, src_w, src_h, dst_w, h_filter);
    freeFilter(h_filter);

    // Source is no longer needed. Free it before allocating the output —
    // this is the key optimization that keeps peak memory under the budget.
    mem.freeSlice(decoded);

    // Allocate output buffer with header.
    const dst_pixel_count = @as(usize, dst_w) * @as(usize, dst_h);
    const out_size = 8 + dst_pixel_count * 4;
    const out = mem.allocSlice(out_size) orelse {
        mem.freeSlice(tmp);
        return null;
    };

    std.mem.writeInt(u32, out[0..4], dst_w, .little);
    std.mem.writeInt(u32, out[4..8], dst_h, .little);

    const v_filter = buildFilter(src_h, dst_h) orelse {
        mem.freeSlice(out);
        mem.freeSlice(tmp);
        return null;
    };

    verticalPass(tmp, out[8..], dst_w, src_h, dst_h, v_filter);
    freeFilter(v_filter);

    // Free the intermediate before unpremultiplying — unpremultiply is
    // in-place, so we don't need tmp any more and freeing it now keeps
    // us at the lowest peak through this final step.
    mem.freeSlice(tmp);

    unpremultiplyAlpha(out[8..][0 .. dst_pixel_count * 4]);

    return out.ptr;
}

fn horizontalPass(src: []const u8, dst: []u8, src_w: u32, src_h: u32, dst_w: u32, f: Filter) void {
    const max_sx: i32 = @as(i32, @intCast(src_w)) - 1;
    const window = f.window;

    for (0..src_h) |y| {
        const row_base = y * src_w * 4;
        const dst_row = y * dst_w * 4;

        for (0..dst_w) |x| {
            const start = f.starts[x];
            const w_off = x * window;

            var accum: Vec4 = @splat(0.0);
            var k: u32 = 0;
            while (k < window) : (k += 1) {
                const sx = std.math.clamp(start + @as(i32, @intCast(k)), 0, max_sx);
                const idx = row_base + @as(usize, @intCast(sx)) * 4;
                const pixel = Vec4{
                    @floatFromInt(src[idx]),
                    @floatFromInt(src[idx + 1]),
                    @floatFromInt(src[idx + 2]),
                    @floatFromInt(src[idx + 3]),
                };
                accum = fma4(pixel, @as(Vec4, @splat(f.weights[w_off + k])), accum);
            }

            const norm: Vec4 = accum * @as(Vec4, @splat(f.norms[x]));
            const clamped = @min(@max(norm, @as(Vec4, @splat(0.0))), @as(Vec4, @splat(255.0)));

            const out_idx = dst_row + x * 4;
            dst[out_idx] = @intFromFloat(clamped[0]);
            dst[out_idx + 1] = @intFromFloat(clamped[1]);
            dst[out_idx + 2] = @intFromFloat(clamped[2]);
            dst[out_idx + 3] = @intFromFloat(clamped[3]);
        }
    }
}

fn verticalPass(src: []const u8, dst: []u8, width: u32, src_h: u32, dst_h: u32, f: Filter) void {
    const max_sy: i32 = @as(i32, @intCast(src_h)) - 1;
    const window = f.window;
    const stride = width * 4;

    for (0..dst_h) |y| {
        const start = f.starts[y];
        const w_off = y * window;
        const norm_v: Vec4 = @splat(f.norms[y]);
        const dst_row = y * stride;

        for (0..width) |x| {
            var accum: Vec4 = @splat(0.0);
            var k: u32 = 0;
            while (k < window) : (k += 1) {
                const sy = std.math.clamp(start + @as(i32, @intCast(k)), 0, max_sy);
                const idx = @as(usize, @intCast(sy)) * stride + x * 4;
                const pixel = Vec4{
                    @floatFromInt(src[idx]),
                    @floatFromInt(src[idx + 1]),
                    @floatFromInt(src[idx + 2]),
                    @floatFromInt(src[idx + 3]),
                };
                accum = fma4(pixel, @as(Vec4, @splat(f.weights[w_off + k])), accum);
            }

            const norm: Vec4 = accum * norm_v;
            const clamped = @min(@max(norm, @as(Vec4, @splat(0.0))), @as(Vec4, @splat(255.0)));

            const out_idx = dst_row + x * 4;
            dst[out_idx] = @intFromFloat(clamped[0]);
            dst[out_idx + 1] = @intFromFloat(clamped[1]);
            dst[out_idx + 2] = @intFromFloat(clamped[2]);
            dst[out_idx + 3] = @intFromFloat(clamped[3]);
        }
    }
}

/// Premultiply RGBA in-place: R,G,B *= A/255, integer math, no rounding error.
/// (R * A * 257 + 32768) >> 16 is exact for u8 values: equals round(R*A/255).
/// Skips the write entirely for opaque pixels (a==255), since R,G,B are
/// already correct.
fn premultiplyAlphaInPlace(data: []u8) void {
    var i: usize = 0;
    while (i + 3 < data.len) : (i += 4) {
        const a: u32 = data[i + 3];
        if (a == 255) {
            // Opaque, no change.
        } else if (a == 0) {
            data[i + 0] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
        } else {
            data[i + 0] = @intCast((@as(u32, data[i + 0]) * a * 257 + 32768) >> 16);
            data[i + 1] = @intCast((@as(u32, data[i + 1]) * a * 257 + 32768) >> 16);
            data[i + 2] = @intCast((@as(u32, data[i + 2]) * a * 257 + 32768) >> 16);
        }
        // Alpha unchanged.
    }
}

/// Unpremultiply RGBA: R,G,B = round(R * 255 / A), in place. Pure integer.
fn unpremultiplyAlpha(data: []u8) void {
    var i: usize = 0;
    while (i + 3 < data.len) : (i += 4) {
        const a: u32 = data[i + 3];
        if (a == 0) {
            data[i + 0] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
        } else if (a < 255) {
            const half = a / 2;
            const r = (@as(u32, data[i + 0]) * 255 + half) / a;
            const g = (@as(u32, data[i + 1]) * 255 + half) / a;
            const b = (@as(u32, data[i + 2]) * 255 + half) / a;
            data[i + 0] = @intCast(@min(r, 255));
            data[i + 1] = @intCast(@min(g, 255));
            data[i + 2] = @intCast(@min(b, 255));
        }
    }
}
