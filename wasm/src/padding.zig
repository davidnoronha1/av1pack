const std = @import("std");

/// Pads an RGBA image of dimensions (src_w, src_h) into a bounding box of
/// (dst_w, dst_h) at offset (0, 0), filling the background with the specified color.
pub fn padRgba(
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
    const total_dst_pixels = dst_w * dst_h;
    var i: usize = 0;
    while (i < total_dst_pixels) : (i += 1) {
        const px = i * 4;
        dst[px + 0] = bg_r;
        dst[px + 1] = bg_g;
        dst[px + 2] = bg_b;
        dst[px + 3] = bg_a;
    }

    const copy_w = @min(src_w, dst_w);
    const copy_h = @min(src_h, dst_h);
    const row_bytes = copy_w * 4;

    var y: u32 = 0;
    while (y < copy_h) : (y += 1) {
        const src_offset = y * src_w * 4;
        const dst_offset = y * dst_w * 4;
        @memcpy(dst[dst_offset .. dst_offset + row_bytes], src[src_offset .. src_offset + row_bytes]);
    }
}

/// Crops a padded RGBA image (src_w, src_h) back to its original dimensions (dst_w, dst_h)
/// starting from the top-left offset (0, 0).
pub fn cropRgba(
    src: [*]const u8,
    src_w: u32,
    src_h: u32,
    dst: [*]u8,
    dst_w: u32,
    dst_h: u32,
) void {
    _ = src_h;
    const copy_w = @min(src_w, dst_w);
    const copy_h = dst_h;
    const row_bytes = copy_w * 4;

    var y: u32 = 0;
    while (y < copy_h) : (y += 1) {
        const src_offset = y * src_w * 4;
        const dst_offset = y * dst_w * 4;
        @memcpy(dst[dst_offset .. dst_offset + row_bytes], src[src_offset .. src_offset + row_bytes]);
    }
}
