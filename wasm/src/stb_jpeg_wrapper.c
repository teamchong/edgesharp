/*
 * Progressive-JPEG decoder backed by vendored stb_image.h.
 *
 * Progressive JPEGs (SOF2 marker) use a multi-scan bitstream that's
 * structurally different from the baseline-sequential layout `jpeg.zig`
 * decodes. stb_image is a public-domain single-file decoder with a mature
 * progressive implementation; vendoring it costs ~13 KB raw / ~6 KB gzip in
 * exchange for full progressive-JPEG support. Output is identical RGBA
 * to the baseline path — both go through the same resize + encode pipeline.
 *
 * Configuration: every non-JPEG format is disabled before the
 * STB_IMAGE_IMPLEMENTATION include, so the linker GC only keeps the JPEG
 * decode path. With -Oz -flto -Wl,--gc-sections the unused formats drop
 * out entirely.
 */
#define STBI_NO_PNG
#define STBI_NO_BMP
#define STBI_NO_PSD
#define STBI_NO_TGA
#define STBI_NO_GIF
#define STBI_NO_HDR
#define STBI_NO_PIC
#define STBI_NO_PNM
#define STBI_NO_LINEAR
#define STBI_NO_STDIO
#define STBI_NO_FAILURE_STRINGS
#define STBI_NO_THREAD_LOCALS
#define STB_IMAGE_IMPLEMENTATION

/*
 * Our libc_glue provides malloc/free; tell stb_image to use them. We don't
 * implement realloc, so define STBI_MALLOC / STBI_FREE only. stb_image uses
 * STBI_REALLOC_SIZED for one path (PNG zlib expansion); since we disabled
 * PNG, that path is dead anyway, but we still need a definition that
 * compiles. Forward to malloc + memcpy + free.
 */
#include <stddef.h>
#include <string.h>

extern void* malloc(size_t);
extern void  free(void*);

static void* edgesharp_realloc_sized(void* p, size_t old_sz, size_t new_sz) {
    (void)old_sz;
    if (!p) return malloc(new_sz);
    if (new_sz == 0) { free(p); return NULL; }
    void* q = malloc(new_sz);
    if (!q) return NULL;
    /* Copy the smaller of old_sz and new_sz; old_sz is a hint, may be larger
     * than the actual allocation, so cap to new_sz. */
    size_t copy = old_sz < new_sz ? old_sz : new_sz;
    memcpy(q, p, copy);
    free(p);
    return q;
}

#define STBI_MALLOC(sz)               malloc(sz)
#define STBI_FREE(p)                  free(p)
#define STBI_REALLOC_SIZED(p,old,new) edgesharp_realloc_sized(p,old,new)

#include "stb_image.h"

/*
 * Decode a progressive JPEG from `src` into RGBA pixels.
 *
 * On success: returns the freshly-allocated RGBA buffer (caller frees with
 * free()), and writes width/height/components to the out-pointers.
 * On failure: returns NULL.
 *
 * `req_comp = 4` forces RGBA output regardless of the source's component
 * count, matching what our resize.zig pipeline expects.
 */
unsigned char* edgesharp_decode_progressive_jpeg(
    const unsigned char* src,
    int src_len,
    int* out_width,
    int* out_height)
{
    int channels;
    return stbi_load_from_memory(src, src_len, out_width, out_height, &channels, 4);
}
