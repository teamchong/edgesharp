/// Native test entry point for edgesharp.
const std = @import("std");
const testing = std.testing;

const resize = @import("resize.zig");
const decode = @import("decode.zig");
const encode = @import("encode.zig");

test "lanczos weight is 1.0 at center" {
    try testing.expectApproxEqAbs(resize.lanczosWeight(0.0), 1.0, 0.0001);
}

test "lanczos weight is 0.0 outside window" {
    try testing.expectApproxEqAbs(resize.lanczosWeight(3.0), 0.0, 0.0001);
    try testing.expectApproxEqAbs(resize.lanczosWeight(-3.0), 0.0, 0.0001);
}

test "lanczos weight is symmetric" {
    try testing.expectApproxEqAbs(resize.lanczosWeight(1.5), resize.lanczosWeight(-1.5), 0.0001);
}

test "detect JPEG magic bytes returns null for truncated data" {
    const jpeg_header = [_]u8{ 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10 };
    try testing.expect(decode.decodeImage(&jpeg_header, jpeg_header.len) == null);
}

test "detect PNG magic bytes returns null for truncated data" {
    const png_header = [_]u8{ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A };
    try testing.expect(decode.decodeImage(&png_header, png_header.len) == null);
}

test "unknown format returns null" {
    const garbage = [_]u8{ 0x00, 0x01, 0x02, 0x03 };
    try testing.expect(decode.decodeImage(&garbage, garbage.len) == null);
}

test "resize zero dimensions returns null" {
    const pixel = [_]u8{ 255, 0, 0, 255 };
    try testing.expect(resize.lanczos3(&pixel, 1, 1, 0, 0) == null);
    try testing.expect(resize.lanczos3(&pixel, 0, 1, 10, 10) == null);
}

test "resize 1x1 to 1x1 preserves pixel" {
    const pixel = [_]u8{ 128, 64, 32, 255 };
    const result = resize.lanczos3(&pixel, 1, 1, 1, 1) orelse return error.ResizeFailed;
    const out = result[8..12];
    try testing.expectEqual(@as(u8, 128), out[0]);
    try testing.expectEqual(@as(u8, 64), out[1]);
    try testing.expectEqual(@as(u8, 32), out[2]);
    try testing.expectEqual(@as(u8, 255), out[3]);
}

test "encode invalid format returns null" {
    const pixel = [_]u8{ 255, 0, 0, 255 };
    try testing.expect(encode.encodeImage(&pixel, 1, 1, 99, 80) == null);
}
