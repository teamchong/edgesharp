/*
 * Advanced libwebp encoder wrapper.
 *
 * libwebp's simple `WebPEncodeRGBA` always uses method=4 (medium speed). We
 * want method=1 (fast — encode 2-3× faster than method=4 at ~5-8% larger
 * output, which on this CDN path is a great trade because every cache hit
 * after the first request is free).
 *
 * Exposing the advanced API directly to Zig requires modeling WebPConfig and
 * WebPPicture struct layouts in Zig's `extern struct` syntax — fragile to
 * libwebp ABI changes. Wrapping it in a tiny C function instead lets the C
 * compiler keep struct layout consistent with the headers it was built from.
 */
#include "src/webp/encode.h"
#include <stddef.h>
#include <stdint.h>

/*
 * Encode RGBA pixels to WebP using the advanced API.
 *
 * Returns the encoded byte count on success (writes the output buffer pointer
 * to *output_ptr — caller must WebPMemoryWriterClear to free).
 * Returns 0 on failure; *output_ptr is left unchanged.
 *
 * `method` is forwarded to WebPConfig.method, range 0 (fastest) to 6 (slowest).
 */
size_t edgesharp_webp_encode(
    const uint8_t* rgba,
    int width,
    int height,
    int stride,
    float quality,
    int method,
    uint8_t** output_ptr,
    WebPMemoryWriter* writer)
{
    WebPConfig config;
    WebPPicture pic;

    if (!WebPConfigInit(&config)) return 0;
    config.quality = quality;
    config.method = method;
    /*
     * Keep `low_memory = 0` (the default). The libwebp docs say it "reduces
     * memory usage but increases CPU use" — wrong trade for us. Workers
     * isolate cap is 128 MB and our peak working set even at 4K input is far
     * below that, so we eat the memory and take the speed.
     */

    if (!WebPValidateConfig(&config)) return 0;
    if (!WebPPictureInit(&pic)) return 0;

    pic.width = width;
    pic.height = height;
    pic.use_argb = 0; /* lossy uses YUV plane internally; let WebPPictureImportRGBA convert */

    if (!WebPPictureImportRGBA(&pic, rgba, stride)) {
        WebPPictureFree(&pic);
        return 0;
    }

    WebPMemoryWriterInit(writer);
    pic.writer = WebPMemoryWrite;
    pic.custom_ptr = writer;

    int ok = WebPEncode(&config, &pic);
    WebPPictureFree(&pic);

    if (!ok) {
        WebPMemoryWriterClear(writer);
        return 0;
    }

    *output_ptr = writer->mem;
    return writer->size;
}

/*
 * The Zig caller doesn't know WebPMemoryWriter's size, so allocate one here
 * and return its bytes-needed. We embed the writer struct inside the function
 * scope and return the buffer + size separately.
 */
size_t edgesharp_webp_writer_size(void) {
    return sizeof(WebPMemoryWriter);
}

void edgesharp_webp_writer_clear(WebPMemoryWriter* writer) {
    WebPMemoryWriterClear(writer);
}
