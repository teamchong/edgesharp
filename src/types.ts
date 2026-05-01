export interface TransformOptions {
  /** Target width in pixels. 0 = no resize. */
  width: number;
  /** Output format. */
  format: "jpeg" | "png" | "webp";
  /** Encode quality 1-100. Default: 80. */
  quality: number;
}

export interface TransformResult {
  /** Encoded image bytes. */
  body: ArrayBuffer;
  /** MIME type of the encoded output. */
  contentType: string;
  /** Width of the output image. */
  width: number;
  /** Height of the output image. */
  height: number;
}

export interface ImageModeConfig {
  /** R2 bucket for caching transformed images. */
  cacheBucket: R2Bucket;
  /** Image DO namespace binding. */
  imageDO: DurableObjectNamespace;
  /** Number of DO slots per datacenter. Default: 8. */
  poolSize?: number;
  /** Maximum input image size in bytes. Default: 10MB. */
  maxInputSize?: number;
  /** Default quality if not specified. Default: 80. */
  defaultQuality?: number;
}
