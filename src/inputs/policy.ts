import path from "node:path";

export type InputKind = "text" | "document" | "data" | "image";

export class InputPolicyError extends Error {
  constructor(
    public readonly code:
      | "INPUT_FILENAME_INVALID"
      | "SENSITIVE_INPUT_BLOCKED"
      | "UNSUPPORTED_INPUT_TYPE"
      | "INVALID_BASE64",
    message: string
  ) {
    super(message);
    this.name = "InputPolicyError";
  }
}

const SENSITIVE_FILENAMES = [
  /^\.env(?:\..+)?$/i,
  /^(?:credentials|secrets?)(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^service[-_.]?account.*\.json$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
];

const ARCHIVE_OR_EXECUTABLE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".tgz",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".msi",
  ".apk",
  ".dmg",
  ".iso",
  ".bin",
  ".class",
  ".jar",
  ".war",
]);

const TEXT_MIME_ALLOW = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/javascript",
  "application/typescript",
]);

const BINARY_ALLOW: Record<string, { extensions: string[]; kind: InputKind; magic: "pdf" | "png" | "jpeg" | "gif" | "zip" | "ole" }> = {
  "application/pdf": { extensions: [".pdf"], kind: "document", magic: "pdf" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    kind: "document",
    magic: "zip",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extensions: [".pptx"],
    kind: "document",
    magic: "zip",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: [".xlsx"],
    kind: "data",
    magic: "zip",
  },
  "application/vnd.ms-excel": {
    extensions: [".xls"],
    kind: "data",
    magic: "ole",
  },
  "image/png": { extensions: [".png"], kind: "image", magic: "png" },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], kind: "image", magic: "jpeg" },
  "image/gif": { extensions: [".gif"], kind: "image", magic: "gif" },
};

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;

export function validateInputFilename(value: string): string {
  const name = value.trim();
  if (!name || name.length > 180) {
    throw new InputPolicyError("INPUT_FILENAME_INVALID", "filename must be 1-180 characters.");
  }
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new InputPolicyError(
      "INPUT_FILENAME_INVALID",
      "filename must be a basename only; directory paths are not accepted."
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new InputPolicyError("INPUT_FILENAME_INVALID", "filename contains control characters.");
  }
  if (SENSITIVE_FILENAMES.some((pattern) => pattern.test(name))) {
    throw new InputPolicyError(
      "SENSITIVE_INPUT_BLOCKED",
      "Refusing a credential/secret-like filename: " + name
    );
  }
  const ext = path.extname(name).toLowerCase();
  if (ARCHIVE_OR_EXECUTABLE_EXTENSIONS.has(ext)) {
    throw new InputPolicyError(
      "UNSUPPORTED_INPUT_TYPE",
      "Archive/executable inputs are intentionally unsupported: " + ext
    );
  }
  return name;
}

export function validateTextMime(mime: string | undefined): string {
  const value = (mime ?? "text/plain").trim().toLowerCase().split(";")[0] ?? "text/plain";
  if (value.startsWith("text/") || TEXT_MIME_ALLOW.has(value)) return value;
  throw new InputPolicyError(
    "UNSUPPORTED_INPUT_TYPE",
    "stage_text accepts text/* or supported structured-text MIME types only."
  );
}

export function scanSensitiveText(content: string): void {
  if (PRIVATE_KEY_PATTERN.test(content)) {
    throw new InputPolicyError(
      "SENSITIVE_INPUT_BLOCKED",
      "Content appears to contain a private key block; refusing to stage it."
    );
  }
}

export function decodeStrictBase64(value: string, maxBytes: number): Buffer {
  if (!value || /\s/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new InputPolicyError("INVALID_BASE64", "data_base64 must be canonical base64 without whitespace.");
  }
  const maxEncoded = Math.ceil(maxBytes / 3) * 4 + 4;
  if (value.length > maxEncoded) {
    throw new InputPolicyError("UNSUPPORTED_INPUT_TYPE", "Encoded input exceeds the configured byte limit.");
  }
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64");
  if (canonical !== value) {
    throw new InputPolicyError("INVALID_BASE64", "data_base64 is not canonical base64.");
  }
  return bytes;
}

function hasMagic(bytes: Buffer, magic: string): boolean {
  if (magic === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (magic === "png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (magic === "jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (magic === "gif") {
    const head = bytes.subarray(0, 6).toString("ascii");
    return head === "GIF87a" || head === "GIF89a";
  }
  if (magic === "zip") return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03,0x05,0x07].includes(bytes[2] ?? -1) && [0x04,0x06,0x08].includes(bytes[3] ?? -1);
  if (magic === "ole") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  return false;
}

export function validateBinaryMetadata(input: {
  filename: string;
  mime: string;
}): { filename: string; mime: string; kind: InputKind; magic: "pdf" | "png" | "jpeg" | "gif" | "zip" | "ole" } {
  const filename = validateInputFilename(input.filename);
  const mime = input.mime.trim().toLowerCase().split(";")[0] ?? "";
  const policy = BINARY_ALLOW[mime];
  if (!policy) {
    throw new InputPolicyError(
      "UNSUPPORTED_INPUT_TYPE",
      "Unsupported binary MIME type. Use stage_text for source/text/data files."
    );
  }
  const ext = path.extname(filename).toLowerCase();
  if (!policy.extensions.includes(ext)) {
    throw new InputPolicyError(
      "UNSUPPORTED_INPUT_TYPE",
      "Filename extension does not match MIME type: " + ext + " vs " + mime
    );
  }
  return { filename, mime, kind: policy.kind, magic: policy.magic };
}

export function validateBinaryInput(input: {
  filename: string;
  mime: string;
  bytes: Buffer;
}): { filename: string; mime: string; kind: InputKind } {
  const metadata = validateBinaryMetadata(input);
  if (!hasMagic(input.bytes, metadata.magic)) {
    throw new InputPolicyError(
      "UNSUPPORTED_INPUT_TYPE",
      "File signature does not match the declared supported type."
    );
  }
  return { filename: metadata.filename, mime: metadata.mime, kind: metadata.kind };
}
