# Discord Activity WebCodecs Guidelines

When working with WebCodecs (`VideoEncoder` / `VideoDecoder`) in the context of Discord Activity's embedded Chromium browser, adhere to the following strict constraints:

## 1. Codec Prioritization
- **Always prioritize `vp8`** as the default codec for video streaming.
- **Do not use H.264 High Profile (`avc1.6400...`)** as the primary option for high resolutions (e.g., 1080p). While the encoder may accept the configuration, the embedded Chromium decoder frequently fails to process it, resulting in dropped frames or infinite loading states. If H.264 is necessary for testing, prioritize Baseline Profile (`avc1.42e0...`).

## 2. VideoFrame Scaling
- **NEVER use an intermediate Canvas** (`OffscreenCanvas` or `Canvas2D`) to manually scale or resize `VideoFrame` objects before passing them to `VideoEncoder`. Calling `ctx.drawImage(videoFrame)` fails silently in Discord Activity, crashing the capture loop without emitting an error.
- **Use native encoder scaling**: To scale a video, pass the target `width` and `height` directly into `VideoEncoder.configure()`. The WebCodecs API will automatically perform hardware downscaling.
