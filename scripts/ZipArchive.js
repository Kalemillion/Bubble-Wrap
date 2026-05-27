const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 0xffff + 22;

function readUint16(view, offset) {
  return view.getUint16(offset, true);
}

function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

function decodeFileName(bytes, flags) {
  if (flags & 0x800) return new TextDecoder("utf-8").decode(bytes);
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function findEndOfCentralDirectory(view) {
  const start = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("Impossible de trouver la fin du répertoire ZIP central.");
}

function buildTreeFromPaths(paths, rootName) {
  const root = { kind: "directory", name: rootName, children: [] };
  for (const rawPath of paths) {
    const normalized = rawPath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized) continue;
    const parts = normalized.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      if (isFile) node.children.push({ kind: "file", name: part });
      else {
        let childDir = node.children.find((c) => c.kind === "directory" && c.name === part);
        if (!childDir) {
          childDir = { kind: "directory", name: part, children: [] };
          node.children.push(childDir);
        }
        node = childDir;
      }
    }
  }
  function sortNode(n) {
    if (!n.children) return;
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    for (const c of n.children) sortNode(c);
  }
  sortNode(root);
  return root;
}

async function decompressDeflateRaw(buffer) {
  // Try using DecompressionStream if available
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("deflate-raw");
    const blob = new Blob([buffer]);
    const stream = blob.stream().pipeThrough(ds);
    const res = await new Response(stream).arrayBuffer();
    return new Uint8Array(res);
  }

  // Fallback to pako if present
  if (typeof window !== "undefined" && window.pako && window.pako.inflateRaw) {
    return window.pako.inflateRaw(new Uint8Array(buffer));
  }

  throw new Error("Aucun décompresseur deflate-raw disponible (installer pako si nécessaire)");
}

export function parseZipArchive(arrayBuffer, rootName = "Workspace") {
  const view = new DataView(arrayBuffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  const totalEntries = readUint16(view, eocdOffset + 10);
  const centralDirectoryOffset = readUint32(view, eocdOffset + 16);

  const paths = [];
  const entries = new Map();
  let offset = centralDirectoryOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) throw new Error("Entrée ZIP centrale invalide.");
    const flags = readUint16(view, offset + 8);
    const compressionMethod = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const uncompressedSize = readUint32(view, offset + 24);
    const fileNameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const localHeaderOffset = readUint32(view, offset + 42);

    const fileNameStart = offset + 46;
    const fileNameBytes = new Uint8Array(arrayBuffer, fileNameStart, fileNameLength);
    const fileName = decodeFileName(fileNameBytes, flags);

    paths.push(fileName);
    entries.set(fileName, {
      fileName,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  function getLocalFileData(name) {
    const meta = entries.get(name);
    if (!meta) return null;
    const lhOff = meta.localHeaderOffset;
    if (view.getUint32(lhOff, true) !== LOCAL_FILE_HEADER_SIGNATURE) throw new Error("Local file header missing");
    const fnameLen = readUint16(view, lhOff + 26);
    const extraLen = readUint16(view, lhOff + 28);
    const dataStart = lhOff + 30 + fnameLen + extraLen;
    const compSlice = arrayBuffer.slice(dataStart, dataStart + meta.compressedSize);
    return { compSlice, compressionMethod: meta.compressionMethod, uncompressedSize: meta.uncompressedSize };
  }

  async function getFileData(name) {
    const local = getLocalFileData(name);
    if (!local) return null;
    if (local.compressionMethod === 0) {
      return new Uint8Array(local.compSlice);
    } else if (local.compressionMethod === 8) {
      return await decompressDeflateRaw(local.compSlice);
    } else {
      throw new Error(`Compression method ${local.compressionMethod} non supportée`);
    }
  }

  return { root: buildTreeFromPaths(paths, rootName), entries, getFileData };
}
