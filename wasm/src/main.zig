const std = @import("std");
const zipper = @import("zipper.zig");
const padding = @import("padding.zig");

const gpa = std.heap.wasm_allocator;

var g_panic_buf: [512]u8 = undefined;
var g_panic_len: u32 = 0;

fn panicFn(msg: []const u8, _: ?usize) noreturn {
    const n = @min(msg.len, g_panic_buf.len);
    @memcpy(g_panic_buf[0..n], msg[0..n]);
    g_panic_len = @intCast(n);
    @trap();
}
pub const panic = std.debug.FullPanic(panicFn);

export fn get_panic_msg_ptr() u32 {
    return @intFromPtr(&g_panic_buf);
}
export fn get_panic_msg_len() u32 {
    return g_panic_len;
}

/// Allocates a contiguous slice of memory in WASM linear memory.
export fn alloc(len: usize) ?[*]u8 {
    const slice = gpa.alloc(u8, len) catch return null;
    return slice.ptr;
}

/// Frees memory allocated by alloc().
export fn free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

/// Pads an RGBA image from (src_w, src_h) to (dst_w, dst_h) at offset (0, 0).
export fn pad_image(
    src: [*]const u8,
    src_w: u32,
    src_h: u32,
    dst: [*]u8,
    dst_w: u32,
    dst_h: u32,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
    bg_a: u8,
) void {
    padding.padRgba(src, src_w, src_h, dst, dst_w, dst_h, bg_r, bg_g, bg_b, bg_a);
}

/// Crops an RGBA image back to (dst_w, dst_h) from top-left (0, 0).
export fn crop_image(
    src: [*]const u8,
    src_w: u32,
    src_h: u32,
    dst: [*]u8,
    dst_w: u32,
    dst_h: u32,
) void {
    padding.cropRgba(src, src_w, src_h, dst, dst_w, dst_h);
}

/// Calculates CRC-32 checksum of a byte slice.
export fn calculate_crc32(ptr: [*]const u8, len: usize) u32 {
    return std.hash.Crc32.hash(ptr[0..len]);
}

// --------------------------------------------------------------------------
// ZIP Archive Generation State
// --------------------------------------------------------------------------

var g_zip_entries: std.ArrayList(zipper.StoredEntry) = std.ArrayList(zipper.StoredEntry).empty;
var g_zip_buf: []u8 = &.{};

/// Resets the ZIP entries list and frees any previously generated ZIP buffer.
export fn zip_reset() void {
    if (g_zip_buf.len > 0) {
        gpa.free(g_zip_buf);
        g_zip_buf = &.{};
    }
    // Free stored names if any were allocated
    for (g_zip_entries.items) |item| {
        gpa.free(item.name);
    }
    g_zip_entries.clearRetainingCapacity();
}

/// Adds a file entry to the pending ZIP archive.
/// Both name and data are copied into WASM memory owned by the builder.
export fn zip_add_file(
    name_ptr: [*]const u8,
    name_len: usize,
    data_ptr: [*]const u8,
    data_len: usize,
) u32 {
    const owned_name = gpa.alloc(u8, name_len) catch return 0;
    @memcpy(owned_name, name_ptr[0..name_len]);

    g_zip_entries.append(gpa, .{
        .name = owned_name,
        .data = data_ptr[0..data_len],
    }) catch {
        gpa.free(owned_name);
        return 0;
    };
    return 1;
}

/// Builds the PKZIP archive from all added entries.
/// Returns the length of the generated ZIP buffer in bytes (or 0 on failure).
export fn zip_build() u32 {
    if (g_zip_buf.len > 0) {
        gpa.free(g_zip_buf);
        g_zip_buf = &.{};
    }

    const zip_bytes = zipper.writeStoredZip(gpa, g_zip_entries.items) catch return 0;
    g_zip_buf = zip_bytes;
    return @intCast(g_zip_buf.len);
}

/// Returns the pointer to the generated ZIP archive bytes.
export fn zip_get_ptr() u32 {
    return @intFromPtr(g_zip_buf.ptr);
}
