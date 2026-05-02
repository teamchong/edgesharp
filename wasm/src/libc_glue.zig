/// Minimal libc implementation for miniz on wasm32-freestanding.
/// Provides malloc/free/realloc/calloc/memcpy/memmove/memset/memcmp/strlen
/// using Zig's wasm_allocator.
const std = @import("std");

const allocator = std.heap.wasm_allocator;

// Track allocation sizes for realloc/free via a simple header.
const AllocHeader = struct {
    size: usize,
};
const HEADER_SIZE = @sizeOf(AllocHeader);

fn headerFromPtr(ptr: *anyopaque) *AllocHeader {
    const byte_ptr: [*]u8 = @ptrCast(ptr);
    return @ptrCast(@alignCast(byte_ptr - HEADER_SIZE));
}

export fn malloc(size: usize) ?*anyopaque {
    const total = size + HEADER_SIZE;
    const slice = allocator.alloc(u8, total) catch return null;
    const header: *AllocHeader = @ptrCast(@alignCast(slice.ptr));
    header.size = size;
    return slice.ptr + HEADER_SIZE;
}

export fn free(ptr: ?*anyopaque) void {
    const p = ptr orelse return;
    const header = headerFromPtr(p);
    const total = header.size + HEADER_SIZE;
    const base: [*]u8 = @as([*]u8, @ptrCast(p)) - HEADER_SIZE;
    allocator.free(base[0..total]);
}

export fn realloc(ptr: ?*anyopaque, new_size: usize) ?*anyopaque {
    if (ptr == null) return malloc(new_size);
    if (new_size == 0) {
        free(ptr);
        return null;
    }

    const header = headerFromPtr(ptr.?);
    const old_size = header.size;
    const new_ptr = malloc(new_size) orelse return null;

    const copy_size = @min(old_size, new_size);
    const src: [*]const u8 = @ptrCast(ptr.?);
    const dst: [*]u8 = @ptrCast(new_ptr);
    @memcpy(dst[0..copy_size], src[0..copy_size]);

    free(ptr);
    return new_ptr;
}

export fn calloc(nmemb: usize, size: usize) ?*anyopaque {
    const total = nmemb * size;
    const ptr = malloc(total) orelse return null;
    const dst: [*]u8 = @ptrCast(ptr);
    @memset(dst[0..total], 0);
    return ptr;
}

export fn memcpy(dest: ?*anyopaque, src: ?*const anyopaque, n: usize) ?*anyopaque {
    if (dest == null or src == null or n == 0) return dest;
    const d: [*]u8 = @ptrCast(dest.?);
    const s: [*]const u8 = @ptrCast(src.?);
    @memcpy(d[0..n], s[0..n]);
    return dest;
}

export fn memmove(dest: ?*anyopaque, src: ?*const anyopaque, n: usize) ?*anyopaque {
    if (dest == null or src == null or n == 0) return dest;
    const d: [*]u8 = @ptrCast(dest.?);
    const s: [*]const u8 = @ptrCast(src.?);

    if (@intFromPtr(d) < @intFromPtr(s)) {
        // Copy forward
        for (0..n) |i| d[i] = s[i];
    } else if (@intFromPtr(d) > @intFromPtr(s)) {
        // Copy backward
        var i = n;
        while (i > 0) {
            i -= 1;
            d[i] = s[i];
        }
    }
    return dest;
}

export fn memset(dest: ?*anyopaque, c_val: c_int, n: usize) ?*anyopaque {
    if (dest == null or n == 0) return dest;
    const d: [*]u8 = @ptrCast(dest.?);
    @memset(d[0..n], @intCast(c_val & 0xFF));
    return dest;
}

export fn memcmp(s1: ?*const anyopaque, s2: ?*const anyopaque, n: usize) c_int {
    if (s1 == null or s2 == null or n == 0) return 0;
    const a: [*]const u8 = @ptrCast(s1.?);
    const b: [*]const u8 = @ptrCast(s2.?);
    for (0..n) |i| {
        if (a[i] != b[i]) {
            return @as(c_int, a[i]) - @as(c_int, b[i]);
        }
    }
    return 0;
}

export fn strlen(s: ?[*:0]const u8) usize {
    const ptr = s orelse return 0;
    var len: usize = 0;
    while (ptr[len] != 0) len += 1;
    return len;
}

export fn abs(x: c_int) c_int {
    return if (x < 0) -x else x;
}

export fn bsearch(
    key: *const anyopaque,
    base: ?*const anyopaque,
    nmemb: usize,
    size: usize,
    compar: *const fn (*const anyopaque, *const anyopaque) callconv(.c) c_int,
) ?*anyopaque {
    if (base == null or nmemb == 0) return null;
    const ptr: [*]const u8 = @ptrCast(base.?);
    var lo: usize = 0;
    var hi: usize = nmemb;
    while (lo < hi) {
        const mid = lo + (hi - lo) / 2;
        const elem: *const anyopaque = @ptrCast(ptr + mid * size);
        const cmp = compar(key, elem);
        if (cmp < 0) {
            hi = mid;
        } else if (cmp > 0) {
            lo = mid + 1;
        } else {
            return @constCast(elem);
        }
    }
    return null;
}

// Math functions required by libwebp.
// On wasm32-freestanding, Zig's @log/@exp builtins emit calls to "log"/"exp"
// symbols which would recurse into these exports. Use WASM intrinsics directly
// for sqrt/floor/ceil, and software implementations for log/exp/pow.
const math = std.math;

// WASM has native intrinsics for sqrt/floor/ceil/abs/nearest.
// Zig's @sqrt/@floor/@ceil/@abs map to these directly on WASM.
// But @round emits a call to "round" symbol, so we use inline asm.
export fn sqrt(x: f64) f64 { return @sqrt(x); }
export fn sqrtf(x: f32) f32 { return @sqrt(x); }
export fn floor(x: f64) f64 { return @floor(x); }
export fn floorf(x: f32) f32 { return @floor(x); }
export fn ceil(x: f64) f64 { return @ceil(x); }
export fn ceilf(x: f32) f32 { return @ceil(x); }
export fn fabs(x: f64) f64 { return @abs(x); }
export fn fabsf(x: f32) f32 { return @abs(x); }

// round via floor (avoids @round which calls "round" symbol on freestanding)
fn softRound64(x: f64) f64 {
    return @floor(x + 0.5);
}

export fn round(x: f64) f64 { return softRound64(x); }
export fn roundf(x: f32) f32 { return @as(f32, @floatCast(softRound64(@floatCast(x)))); }

// Software log/exp for wasm32-freestanding.
// Zig's @log/@exp builtins emit calls to "log"/"exp" C symbols which would
// recurse into these exports. These use direct IEEE 754 bit manipulation.

fn softLog64(x: f64) f64 {
    if (x <= 0.0) return -math.inf(f64);
    if (x == 1.0) return 0.0;

    const LN2: f64 = 0.6931471805599453;
    const bits: u64 = @bitCast(x);
    const raw_exp: i64 = @as(i64, @intCast((bits >> 52) & 0x7FF)) - 1023;

    // Normalize mantissa to [1.0, 2.0)
    const m_bits: u64 = (bits & 0x000FFFFFFFFFFFFF) | (@as(u64, 1023) << 52);
    const m: f64 = @bitCast(m_bits);

    // log(m) for m in [1,2) using Pade approximant via (m-1)/(m+1) = t
    const t = (m - 1.0) / (m + 1.0);
    const t2 = t * t;
    // ln(m) = 2*t*(1 + t^2/3 + t^4/5 + t^6/7 + t^8/9)
    const ln_m = 2.0 * t * (1.0 + t2 * (1.0 / 3.0 + t2 * (1.0 / 5.0 + t2 * (1.0 / 7.0 + t2 * (1.0 / 9.0 + t2 * (1.0 / 11.0))))));

    return @as(f64, @floatFromInt(raw_exp)) * LN2 + ln_m;
}

fn softExp64(x: f64) f64 {
    if (x == 0.0) return 1.0;
    if (x > 709.0) return math.inf(f64);
    if (x < -745.0) return 0.0;

    const LOG2E: f64 = 1.4426950408889634;
    const LN2: f64 = 0.6931471805599453;

    // exp(x) = 2^n * exp(r) where n = round(x/ln2), r = x - n*ln2
    const n_f = softRound64(x * LOG2E);
    const n: i64 = @intFromFloat(n_f);
    const r = x - n_f * LN2;

    // exp(r) for small r via Taylor series: 1 + r + r^2/2 + r^3/6 + ...
    const r2 = r * r;
    const p = 1.0 + r * (1.0 + r * (0.5 + r * (1.0 / 6.0 + r * (1.0 / 24.0 + r * (1.0 / 120.0 + r * (1.0 / 720.0))))));
    _ = r2;

    // 2^n via bit manipulation
    if (n < -1022 or n > 1023) {
        // Fallback for extreme exponents
        var result = p;
        var remaining = n;
        while (remaining > 0) : (remaining -= 1) result *= 2.0;
        while (remaining < 0) : (remaining += 1) result *= 0.5;
        return result;
    }
    const exp_bits: u64 = @intCast(@as(i64, 1023 + n) << 52);
    const scale: f64 = @bitCast(exp_bits);
    return p * scale;
}

export fn log(x: f64) f64 { return softLog64(x); }
export fn log2(x: f64) f64 { return softLog64(x) * 1.4426950408889634; }
export fn log10(x: f64) f64 { return softLog64(x) * 0.4342944819032518; }
export fn exp(x: f64) f64 { return softExp64(x); }

export fn pow(x: f64, y: f64) f64 {
    if (y == 0.0) return 1.0;
    if (x == 0.0) return 0.0;
    if (x < 0.0) return -softExp64(y * softLog64(-x)); // negative base, integer y assumed
    return softExp64(y * softLog64(x));
}

export fn logf(x: f32) f32 { return @floatCast(softLog64(@floatCast(x))); }
export fn log2f(x: f32) f32 { return @floatCast(softLog64(@floatCast(x)) * 1.4426950408889634); }
export fn powf(x: f32, y: f32) f32 {
    return @floatCast(pow(@floatCast(x), @floatCast(y)));
}
export fn expf(x: f32) f32 { return @floatCast(softExp64(@floatCast(x))); }

/// Insertion sort, libwebp uses qsort on palette arrays (<= 256 entries).
export fn qsort(
    base: ?*anyopaque,
    nmemb: usize,
    size: usize,
    compar: *const fn (*const anyopaque, *const anyopaque) callconv(.c) c_int,
) void {
    if (base == null or nmemb <= 1 or size == 0) return;
    const ptr: [*]u8 = @ptrCast(base.?);
    const tmp = allocator.alloc(u8, size) catch return;
    defer allocator.free(tmp);

    var i: usize = 1;
    while (i < nmemb) : (i += 1) {
        var j = i;
        while (j > 0) {
            const a_ptr = ptr + j * size;
            const b_ptr = ptr + (j - 1) * size;
            if (compar(a_ptr, b_ptr) < 0) {
                @memcpy(tmp, a_ptr[0..size]);
                @memcpy(a_ptr[0..size], b_ptr[0..size]);
                @memcpy(b_ptr[0..size], tmp);
                j -= 1;
            } else {
                break;
            }
        }
    }
}
