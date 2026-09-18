import type { Locator } from "playwright";
import {
  CITATION_SELECTOR,
  FILE_ASSET_SELECTOR,
  IMAGE_ASSET_SELECTOR,
  PREVIEW_SELECTOR,
  WRITING_BLOCK_SELECTOR,
} from "./selectors.js";
import { AssetStore } from "../assets/store.js";

export interface TextPart {
  type: "text";
  text: string;
}

export interface CodePart {
  type: "code";
  language: string | null;
  text: string;
}

export interface WritingBlockPart {
  type: "writing_block";
  title: string | null;
  text: string;
  editable: boolean;
}

export interface TablePart {
  type: "table";
  headers: string[];
  rows: string[][];
  markdown: string;
}

export interface CitationPart {
  type: "citation";
  label: string | null;
  title: string | null;
  url: string | null;
}

export interface FilePart {
  type: "file";
  assetId: string;
  filename: string | null;
  mime: string | null;
  downloadable: true;
}

export interface ImagePart {
  type: "image";
  assetId: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export interface PreviewPart {
  type: "preview";
  kind: string | null;
  title: string | null;
  text: string | null;
}

export type ResponsePart =
  | TextPart
  | CodePart
  | WritingBlockPart
  | TablePart
  | CitationPart
  | FilePart
  | ImagePart
  | PreviewPart;

export interface ResponseManifest {
  version: 1;
  plainText: string;
  parts: ResponsePart[];
  assistantIndex: number;
  structured: boolean;
  assetCount: number;
  codeBlockCount: number;
}

type RawPart =
  | TextPart
  | CodePart
  | WritingBlockPart
  | TablePart
  | CitationPart
  | { type: "file"; ordinal: number; filename: string | null; mime: string | null }
  | {
      type: "image";
      ordinal: number;
      alt: string | null;
      width: number | null;
      height: number | null;
    }
  | PreviewPart;

function cleanMultiline(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export async function extractResponseManifest(input: {
  message: Locator;
  conversationId: string;
  projectId?: string | null;
  assistantIndex: number;
  assetStore: AssetStore;
}): Promise<ResponseManifest> {
  const raw = await input.message.evaluate(
    (root, selectors) => {
      const host = root as HTMLElement;
      const fileNodes = Array.from(host.querySelectorAll(selectors.file));
      const imageNodes = Array.from(host.querySelectorAll(selectors.image)).filter((node) => {
        const image = node as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        const width = image.naturalWidth || rect.width || Number(image.getAttribute("width")) || 0;
        const height = image.naturalHeight || rect.height || Number(image.getAttribute("height")) || 0;
        const alt = image.getAttribute("alt") ?? "";
        return width >= 48 || height >= 48 || alt.trim().length > 0;
      });

      const parts: RawPart[] = [];
      let textBuffer = "";

      const normalizeUrl = (href: string | null): string | null => {
        if (!href) return null;
        try {
          const url = new URL(href, location.href);
          if (url.protocol !== "http:" && url.protocol !== "https:") return null;
          for (const key of Array.from(url.searchParams.keys())) {
            if (/(?:token|auth|signature|sig|session|api[_-]?key|access[_-]?key|code)/i.test(key)) {
              url.searchParams.delete(key);
            }
          }
          url.hash = "";
          const value = url.toString();
          return value.length <= 2048 ? value : null;
        } catch {
          return null;
        }
      };

      const flushText = () => {
        const text = textBuffer
          .replace(/\r\n/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        textBuffer = "";
        if (text) parts.push({ type: "text", text });
      };

      const appendText = (value: string) => {
        textBuffer += value;
      };

      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return element.getAttribute("aria-hidden") !== "true";
      };

      const languageOf = (pre: Element): string | null => {
        const code = pre.querySelector("code");
        for (const source of [code, pre].filter(Boolean) as Element[]) {
          const data =
            source.getAttribute("data-language") ??
            source.getAttribute("data-lang") ??
            source.getAttribute("lang");
          if (data?.trim()) return data.trim().slice(0, 80);
          for (const klass of Array.from(source.classList)) {
            const match = klass.match(/^(?:language|lang)-(.+)$/i);
            if (match?.[1]) return match[1].slice(0, 80);
          }
        }
        return null;
      };

      const tablePart = (table: HTMLTableElement): RawPart => {
        const allRows = Array.from(table.querySelectorAll("tr")).map((row) =>
          Array.from(row.querySelectorAll("th,td")).map((cell) =>
            (cell.textContent ?? "").replace(/\s+/g, " ").trim()
          )
        );
        let headers = Array.from(table.querySelectorAll("thead th")).map((cell) =>
          (cell.textContent ?? "").replace(/\s+/g, " ").trim()
        );
        let rows = allRows;
        if (headers.length === 0 && allRows.length > 0) {
          const first = table.querySelector("tr");
          if (first && first.querySelectorAll("th").length > 0) {
            headers = allRows[0] ?? [];
            rows = allRows.slice(1);
          }
        }
        const width = Math.max(headers.length, ...rows.map((row) => row.length), 0);
        const effectiveHeaders =
          headers.length > 0 ? headers : Array.from({ length: width }, (_, i) => "Column " + (i + 1));
        const escape = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
        const markdown =
          effectiveHeaders.length === 0
            ? ""
            : [
                "| " + effectiveHeaders.map(escape).join(" | ") + " |",
                "| " + effectiveHeaders.map(() => "---").join(" | ") + " |",
                ...rows.map(
                  (row) =>
                    "| " +
                    Array.from({ length: effectiveHeaders.length }, (_, i) => escape(row[i] ?? "")).join(
                      " | "
                    ) +
                    " |"
                ),
              ].join("\n");
        return { type: "table", headers: effectiveHeaders, rows, markdown };
      };

      const filenameFor = (element: Element): string | null => {
        const direct =
          element.getAttribute("download") ??
          element.getAttribute("data-filename") ??
          element.getAttribute("data-file-name");
        if (direct?.trim()) return direct.trim().slice(0, 200);
        const anchor = element.matches("a") ? element : element.querySelector("a");
        const fromAnchor = anchor?.getAttribute("download");
        if (fromAnchor?.trim()) return fromAnchor.trim().slice(0, 200);
        const label =
          element.getAttribute("aria-label") ??
          element.getAttribute("title") ??
          element.textContent ??
          "";
        const cleaned = label.replace(/\s+/g, " ").trim();
        const match = cleaned.match(/([\w.@()+\- ]+\.[A-Za-z0-9]{1,12})/);
        const value = match?.[1] ?? cleaned;
        return value ? value.slice(0, 200) : null;
      };

      const mimeFor = (element: Element): string | null => {
        const value =
          element.getAttribute("data-mime") ??
          element.getAttribute("data-mime-type") ??
          element.getAttribute("type");
        return value?.trim().slice(0, 120) || null;
      };

      const blockTags = new Set([
        "P",
        "DIV",
        "SECTION",
        "ARTICLE",
        "LI",
        "UL",
        "OL",
        "BLOCKQUOTE",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
      ]);

      const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
          appendText(node.nodeValue ?? "");
          return;
        }
        if (!(node instanceof Element) || !visible(node)) return;

        const tag = node.tagName;
        if (["SCRIPT", "STYLE", "SVG", "NOSCRIPT"].includes(tag)) return;
        if (tag === "BUTTON") return;

        if (node.matches(selectors.writing)) {
          flushText();
          const element = node as HTMLElement;
          const title =
            node.getAttribute("aria-label") ??
            node.getAttribute("title") ??
            node.getAttribute("data-title");
          parts.push({
            type: "writing_block",
            title: title?.trim().slice(0, 200) || null,
            text: (element.innerText ?? node.textContent ?? "").replace(/\r\n/g, "\n").trim(),
            editable: Boolean(
              node.matches('[contenteditable="true"]') ||
                node.querySelector('[contenteditable="true"]')
            ),
          });
          return;
        }

        if (tag === "PRE") {
          flushText();
          const code = node.querySelector("code");
          parts.push({
            type: "code",
            language: languageOf(node),
            text: (code?.textContent ?? node.textContent ?? "").replace(/\r\n/g, "\n"),
          });
          return;
        }

        if (tag === "TABLE") {
          flushText();
          parts.push(tablePart(node as HTMLTableElement));
          return;
        }

        if (node.matches(selectors.file)) {
          flushText();
          parts.push({
            type: "file",
            ordinal: fileNodes.indexOf(node),
            filename: filenameFor(node),
            mime: mimeFor(node),
          });
          return;
        }

        if (tag === "IMG" && imageNodes.includes(node)) {
          flushText();
          const image = node as HTMLImageElement;
          const rect = image.getBoundingClientRect();
          parts.push({
            type: "image",
            ordinal: imageNodes.indexOf(node),
            alt: image.getAttribute("alt")?.trim().slice(0, 500) || null,
            width: Math.round(image.naturalWidth || rect.width || 0) || null,
            height: Math.round(image.naturalHeight || rect.height || 0) || null,
          });
          return;
        }

        if (node.matches(selectors.citation)) {
          flushText();
          const anchor = node.matches("a") ? (node as HTMLAnchorElement) : node.querySelector("a");
          parts.push({
            type: "citation",
            label: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null,
            title:
              node.getAttribute("title")?.trim().slice(0, 500) ??
              anchor?.getAttribute("title")?.trim().slice(0, 500) ??
              null,
            url: normalizeUrl(anchor?.getAttribute("href") ?? null),
          });
          return;
        }

        if (node.matches(selectors.preview)) {
          flushText();
          const text = (node as HTMLElement).innerText?.replace(/\r\n/g, "\n").trim() ?? "";
          parts.push({
            type: "preview",
            kind: node.getAttribute("data-testid")?.trim().slice(0, 120) ?? node.tagName.toLowerCase(),
            title:
              node.getAttribute("aria-label")?.trim().slice(0, 200) ??
              node.getAttribute("title")?.trim().slice(0, 200) ??
              null,
            text: text ? text.slice(0, 20_000) : null,
          });
          return;
        }

        const block = blockTags.has(tag);
        if (block) flushText();
        for (const child of Array.from(node.childNodes)) walk(child);
        if (block) {
          appendText("\n");
          flushText();
        }
      };

      for (const child of Array.from(host.childNodes)) walk(child);
      flushText();

      return {
        plainText: (host.innerText ?? host.textContent ?? "").replace(/\r\n/g, "\n").trim(),
        parts,
      };
    },
    {
      writing: WRITING_BLOCK_SELECTOR,
      file: FILE_ASSET_SELECTOR,
      image: IMAGE_ASSET_SELECTOR,
      citation: CITATION_SELECTOR,
      preview: PREVIEW_SELECTOR,
    }
  );

  const parts: ResponsePart[] = raw.parts.map((part) => {
    if (part.type === "file") {
      const record = input.assetStore.register({
        conversationId: input.conversationId,
        projectId: input.projectId ?? null,
        assistantIndex: input.assistantIndex,
        kind: "file",
        ordinal: part.ordinal,
        filename: part.filename,
        mime: part.mime,
      });
      return {
        type: "file",
        assetId: record.assetId,
        filename: record.filename,
        mime: record.mime,
        downloadable: true,
      };
    }
    if (part.type === "image") {
      const record = input.assetStore.register({
        conversationId: input.conversationId,
        projectId: input.projectId ?? null,
        assistantIndex: input.assistantIndex,
        kind: "image",
        ordinal: part.ordinal,
        filename: part.alt,
      });
      return {
        type: "image",
        assetId: record.assetId,
        alt: part.alt,
        width: part.width,
        height: part.height,
      };
    }
    return part;
  });

  return {
    version: 1,
    plainText: cleanMultiline(raw.plainText),
    parts,
    assistantIndex: input.assistantIndex,
    structured: parts.some((part) => part.type !== "text"),
    assetCount: parts.filter((part) => part.type === "file" || part.type === "image").length,
    codeBlockCount: parts.filter((part) => part.type === "code").length,
  };
}
