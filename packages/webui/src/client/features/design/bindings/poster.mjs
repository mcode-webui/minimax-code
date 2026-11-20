/** Capture only a bounded preview; cross-origin sampling is an allowed absence. */
export async function captureDesignVideoPoster(video) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2)
    return undefined;
  const ratio = Math.min(
    1,
    256 / Math.max(video.videoWidth, video.videoHeight),
  );
  const canvas = video.ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
  canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.7),
    );
    if (!blob || blob.size > 128 * 1024) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    );
  } catch (error) {
    if (error?.name === "SecurityError") return undefined;
    throw error;
  }
}
