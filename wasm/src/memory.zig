/// WASM linear memory allocator.
/// Exports alloc/free for the JS host to manage buffers.
const std = @import("std");

var gpa = std.heap.wasm_allocator;

pub fn alloc(len: u32) ?[*]u8 {
    const slice = gpa.alloc(u8, len) catch return null;
    return slice.ptr;
}

pub fn free(ptr: [*]u8, len: u32) void {
    gpa.free(ptr[0..len]);
}

pub fn allocSlice(len: usize) ?[]u8 {
    return gpa.alloc(u8, len) catch null;
}

pub fn freeSlice(slice: []u8) void {
    gpa.free(slice);
}
