import { REMOTE_ATTACHMENT_BYTES } from "../../app/remoteChat";

export interface PickedImage { key: string; preview: string; data: string; bytes: number }
/** Screenshots are shrunk to a readable JPEG so they upload quickly over the relay. */
export async function readRemoteImage(file: File): Promise<PickedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot read the image.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", 0.82);
  const data = url.slice(url.indexOf(",") + 1);
  const bytes = Math.floor(data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > REMOTE_ATTACHMENT_BYTES) throw new Error("The image is too large.");
  return { key: crypto.randomUUID(), preview: url, data, bytes };
}
