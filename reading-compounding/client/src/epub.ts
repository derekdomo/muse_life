// Minimal client-side EPUB reader: ZIP unpack + OPF/spine walk +
// chapter sanitization, all in the browser. The book file never leaves
// the device except into this app's own private storage (sanitized
// chapter HTML + the original bytes as a blob via server actions).
//
// ZIP support: stored (0) and deflate (8, via the browser's native
// DecompressionStream). Anything else fails honestly — the import flow
// records status 失败 and keeps the original file for a retry.

export interface ParsedChapter {
  title: string | null;
  html: string;
}

export interface ParsedEpub {
  title: string;
  author: string | null;
  chapters: ParsedChapter[];
}

const td = new TextDecoder("utf-8");

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the End Of Central Directory record (scan the tail).
  let eocd = -1;
  const start = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP/EPUB 文件（找不到中央目录）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    // Local header: skip its name/extra to reach the data.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      files.set(name, new Uint8Array(raw));
    } else if (method === 8) {
      files.set(name, await inflateRaw(raw));
    } else {
      throw new Error(`EPUB 使用了不支持的压缩方式（method ${method}）`);
    }
  }
  return files;
}

function resolvePath(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0] ?? href);
  const parts = (baseDir ? `${baseDir}/${clean}` : clean).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// Strip everything that could execute, load remote resources, or leak:
// scripts, forms, event handlers, style attributes (may carry remote
// url()), href/src references. Images are separate EPUB files we do
// not ship to the server, so <img>/<svg>/<image> are dropped rather
// than left as broken remote references.
const DROP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "LINK",
  "META",
  "AUDIO",
  "VIDEO",
  "IMG",
  "SVG",
  "IMAGE",
  "SOURCE",
  "TRACK",
]);

export function sanitizeChapterHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (DROP_TAGS.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (
          name.startsWith("on") ||
          name === "style" ||
          name === "href" ||
          name === "src" ||
          name === "xlink:href" ||
          name === "background" ||
          name === "poster"
        ) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(body);
  return body.innerHTML;
}

function firstHeadingText(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const h = doc.querySelector("h1, h2, h3");
  const text = h?.textContent?.trim();
  return text ? text.slice(0, 120) : null;
}

export async function parseEpub(file: File): Promise<ParsedEpub> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持解压 EPUB（缺少 DecompressionStream）");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = await unzip(bytes);
  const containerBuf = files.get("META-INF/container.xml");
  if (!containerBuf) throw new Error("不是有效的 EPUB（缺少 container.xml）");
  const container = new DOMParser().parseFromString(td.decode(containerBuf), "text/xml");
  const rootfile = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfile) throw new Error("EPUB 未声明内容清单（rootfile）");
  const opfBuf = files.get(rootfile);
  if (!opfBuf) throw new Error("EPUB 内容清单文件缺失");
  const opf = new DOMParser().parseFromString(td.decode(opfBuf), "text/xml");
  const baseDir = rootfile.includes("/")
    ? rootfile.slice(0, rootfile.lastIndexOf("/"))
    : "";

  const title =
    opf.querySelector("metadata > title, metadata title")?.textContent?.trim() ||
    file.name.replace(/\.epub$/i, "");
  const author =
    opf.querySelector("metadata > creator, metadata creator")?.textContent?.trim() ||
    null;

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  opf.querySelectorAll("manifest > item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) {
      manifest.set(id, {
        href,
        type: item.getAttribute("media-type") ?? "",
        props: item.getAttribute("properties") ?? "",
      });
    }
  });

  // Table of contents: EPUB3 nav document first, then NCX.
  const tocByFile = new Map<string, string>();
  const navItem = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  if (navItem) {
    const navBuf = files.get(resolvePath(baseDir, navItem.href));
    if (navBuf) {
      const navDoc = new DOMParser().parseFromString(td.decode(navBuf), "text/html");
      navDoc.querySelectorAll("nav a[href]").forEach((a) => {
        const href = a.getAttribute("href") ?? "";
        const filePart = href.split("#")[0];
        const label = a.textContent?.trim();
        if (filePart && label && !tocByFile.has(filePart.split("/").pop() ?? filePart)) {
          tocByFile.set(filePart.split("/").pop() ?? filePart, label);
        }
      });
    }
  }
  if (tocByFile.size === 0) {
    const ncxItem = [...manifest.values()].find(
      (m) => m.type === "application/x-dtbncx+xml",
    );
    if (ncxItem) {
      const ncxBuf = files.get(resolvePath(baseDir, ncxItem.href));
      if (ncxBuf) {
        const ncx = new DOMParser().parseFromString(td.decode(ncxBuf), "text/xml");
        ncx.querySelectorAll("navPoint").forEach((pt) => {
          const src = pt.querySelector("content")?.getAttribute("src") ?? "";
          const label = pt.querySelector("navLabel > text, navLabel text")?.textContent?.trim();
          const filePart = src.split("#")[0] ?? "";
          const base = filePart.split("/").pop() ?? filePart;
          if (base && label && !tocByFile.has(base)) tocByFile.set(base, label);
        });
      }
    }
  }

  const chapters: ParsedChapter[] = [];
  const spineItems = opf.querySelectorAll("spine > itemref");
  for (const ref of Array.from(spineItems)) {
    const idref = ref.getAttribute("idref");
    if (!idref) continue;
    const item = manifest.get(idref);
    if (!item) continue;
    if (!/xhtml|html|xml/.test(item.type) && item.type !== "") continue;
    const path = resolvePath(baseDir, item.href);
    const buf = files.get(path);
    if (!buf) continue;
    const raw = td.decode(buf);
    const html = sanitizeChapterHtml(raw);
    const plain = new DOMParser().parseFromString(html, "text/html").body?.textContent ?? "";
    if (!plain.trim()) continue; // skip empty spine shells
    const fileBase = path.split("/").pop() ?? path;
    const tocTitle = tocByFile.get(fileBase) ?? tocByFile.get(item.href.split("/").pop() ?? item.href);
    chapters.push({
      title: tocTitle ?? firstHeadingText(html),
      html,
    });
  }
  if (chapters.length === 0) {
    throw new Error("EPUB 里没有解析到任何正文章节");
  }
  return { title, author, chapters };
}
