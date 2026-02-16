import { randomBytes } from "crypto";
import { extname } from "path";

const MAX_FILENAME_LENGTH = 100;
const SAFE_FILENAME_REGEX = /[^a-zA-Z0-9\-_]/g;
const FILE_TYPE_SUFFIXES: { [key: string]: string } = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "file",
  "application/vnd.ms-excel": "file",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "file",
  "text/csv": "file",
  "video/mp4": "video",
  "video/mpeg": "video",
  "video/webm": "video",
};

export const generateSafeFilename = (originalFilename: string, mimetype: string): string => {
  const extension = extname(originalFilename).toLowerCase();
  const suffix = FILE_TYPE_SUFFIXES[mimetype] || "file";

  const timestamp = Date.now().toString(36);
  const randomId = randomBytes(4).toString("hex");
  let newName = `${timestamp}-${randomId}-${suffix}`;

  newName = newName.replace(SAFE_FILENAME_REGEX, "-");
  newName = newName.replace(/-+/g, "-");
  newName = newName.replace(/^-+|-+$/g, "");

  if (newName.length > MAX_FILENAME_LENGTH - extension.length) {
    newName = newName.slice(0, MAX_FILENAME_LENGTH - extension.length);
  }

  return `${newName}${extension}`;
};
