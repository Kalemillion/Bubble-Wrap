const TEXT_DECODER = new TextDecoder("utf-8");
const TEXT_ENCODER = new TextEncoder();
const ZSTD_MAGIC = "\x28\xb5\x2f\xfd";
let zstdRuntimePromise = null;
let zstdDictPromise = null;

async function loadZstdDictionary() {
  if (!zstdDictPromise) {
    zstdDictPromise = (async () => {
      const candidates = [
        new URL("../data/zsdic", import.meta.url).href,
        new URL("./zstd_dict.bin", import.meta.url).href,
      ];

      for (const src of candidates) {
        try {
          const response = await fetch(src);
          if (!response.ok) continue;
          return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          // try next candidate
        }
      }

      throw new Error("Dictionnaire Zstd introuvable (attendu: data/zsdic).");
    })();
  }

  return await zstdDictPromise;
}

async function getZstdRuntime() {
  if (!zstdRuntimePromise) {
    zstdRuntimePromise = (async () => {
      const candidates = [
        "https://unpkg.com/@bokuweb/zstd-wasm/dist/web/index.web.js",
      ];

      for (const src of candidates) {
        try {
          const module = await import(src);
          await module.init();
          return module;
        } catch (error) {
          // try next candidate
        }
      }

      throw new Error("Impossible de charger @bokuweb/zstd-wasm.");
    })();
  }

  return await zstdRuntimePromise;
}

function readUint16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

function readUint32(view, offset, littleEndian) {
  return view.getUint32(offset, littleEndian);
}

function decodeString(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return TEXT_DECODER.decode(bytes.subarray(offset, end));
}

function bytesToAscii(bytes, offset, length) {
  let result = "";
  for (let index = 0; index < length; index++) result += String.fromCharCode(bytes[offset + index]);
  return result;
}

function isPrintableText(value) {
  return /[\r\n\t]/.test(value) || /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(value);
}

function decodeJsonPretty(value) {
  if (typeof value !== "string") return String(value);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch (error) {
    return value;
  }
}

function pushDebug(trace, message) {
  trace.push(message);
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(`[SARC] ${message}`);
  }
}

function decodeCborItem(bytes, state) {
  const initialByte = bytes[state.index++];
  const majorType = initialByte >> 5;
  const additional = initialByte & 0x1f;

  const readLength = () => {
    if (additional < 24) return additional;
    if (additional === 24) return bytes[state.index++];
    if (additional === 25) return (bytes[state.index++] << 8) | bytes[state.index++];
    if (additional === 26) {
      return ((bytes[state.index++] << 24) >>> 0) | (bytes[state.index++] << 16) | (bytes[state.index++] << 8) | bytes[state.index++];
    }
    if (additional === 27) {
      let value = 0;
      for (let shift = 7; shift >= 0; shift--) value = (value * 256) + bytes[state.index++];
      return value;
    }
    if (additional === 31) return -1;
    throw new Error(`CBOR supplémentaire non supporté: ${additional}`);
  };

  switch (majorType) {
    case 0: {
      return readLength();
    }
    case 1: {
      return -1 - readLength();
    }
    case 2: {
      const length = readLength();
      if (length === -1) {
        const chunks = [];
        while (bytes[state.index] !== 0xff) chunks.push(decodeCborItem(bytes, state));
        state.index++;
        return chunks;
      }
      const value = bytes.subarray(state.index, state.index + length);
      state.index += length;
      return value;
    }
    case 3: {
      const length = readLength();
      if (length === -1) {
        let text = "";
        while (bytes[state.index] !== 0xff) text += decodeCborItem(bytes, state);
        state.index++;
        return text;
      }
      const value = TEXT_DECODER.decode(bytes.subarray(state.index, state.index + length));
      state.index += length;
      return value;
    }
    case 4: {
      const length = readLength();
      const values = [];
      if (length === -1) {
        while (bytes[state.index] !== 0xff) values.push(decodeCborItem(bytes, state));
        state.index++;
        return values;
      }
      for (let index = 0; index < length; index++) values.push(decodeCborItem(bytes, state));
      return values;
    }
    case 5: {
      const length = readLength();
      const object = {};
      const readEntry = () => {
        const key = decodeCborItem(bytes, state);
        object[String(key)] = decodeCborItem(bytes, state);
      };
      if (length === -1) {
        while (bytes[state.index] !== 0xff) readEntry();
        state.index++;
        return object;
      }
      for (let index = 0; index < length; index++) readEntry();
      return object;
    }
    case 6: {
      return decodeCborItem(bytes, state);
    }
    case 7: {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22 || additional === 23) return null;
      if (additional === 24) return bytes[state.index++];
      if (additional === 25) {
        const half = (bytes[state.index++] << 8) | bytes[state.index++];
        const sign = (half & 0x8000) ? -1 : 1;
        const exponent = (half >> 10) & 0x1f;
        const fraction = half & 0x03ff;
        if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
        if (exponent === 31) return fraction ? NaN : sign * Infinity;
        return sign * Math.pow(2, exponent - 15) * (1 + (fraction / 1024));
      }
      if (additional === 26) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + state.index, 4);
        const value = view.getFloat32(0, false);
        state.index += 4;
        return value;
      }
      if (additional === 27) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + state.index, 8);
        const value = view.getFloat64(0, false);
        state.index += 8;
        return value;
      }
      if (additional === 31) return undefined;
      return additional;
    }
    default:
      throw new Error(`CBOR major type non supporté: ${majorType}`);
  }
}

function decodeCbor(bytes) {
  const state = { index: 0 };
  const value = decodeCborItem(bytes, state);
  return { value, bytesRead: state.index };
}

function extractMessagePackEntries(resource) {
  const mergeable = resource?.Mergeable;
  const messagePack = mergeable?.MessagePack ?? resource?.MessagePack;
  console.debug("[extractMessagePackEntries] messagePack exists:", !!messagePack, "type:", typeof messagePack, "isArray:", Array.isArray(messagePack));
  if (!messagePack || typeof messagePack !== "object" || Array.isArray(messagePack)) {
    console.debug("[extractMessagePackEntries] Rejet: messagePack invalide.");
    return null;
  }

  console.debug("[extractMessagePackEntries] Clés de premier niveau:", Object.keys(messagePack).slice(0, 10));

  const entries = [];
  let leafCount = 0;

  function traverse(obj, path = [], depth = 0) {
    if (obj === null) {
      if (depth === 0) console.debug(`[traverse@${depth}] obj est null, arrêt.`);
      return;
    }
    if (Array.isArray(obj)) {
      // Parcourir les éléments d'un tableau : on descend dans les objets,
      // et pour les valeurs primitives on crée une feuille au chemin courant.
      for (let i = 0; i < obj.length; i++) {
        const el = obj[i];
        if (el === null) continue;
        if (typeof el === "object") {
          traverse(el, path, depth + 1);
        } else {
          const name = path.join("/");
          const text = decodeJsonPretty(el);
          entries.push({
            name,
            data: TEXT_ENCODER.encode(typeof el === "string" ? el : JSON.stringify(el)),
            text,
            isText: isPrintableText(text),
            format: "json",
          });
          leafCount++;
        }
      }
      return;
    }
    if (typeof obj !== "object") {
      // Feuille: créer une entrée avec le chemin complet
      const name = path.join("/");
      const text = decodeJsonPretty(obj);
      entries.push({
        name,
        data: TEXT_ENCODER.encode(typeof obj === "string" ? obj : JSON.stringify(obj)),
        text,
        isText: isPrintableText(text),
        format: "json",
      });
      leafCount++;
      if (leafCount % 100 === 0) {
        console.debug(`[traverse@${depth}] Feuilles trouvées: ${leafCount}, dernière: ${name.substring(0, 50)}`);
      }
      return;
    }

    // Traverser récursivement l'objet
    const keys = Object.keys(obj);
    if (depth < 3) {
      console.debug(`[traverse@${depth}] Nœud avec ${keys.length} clés:`, keys.slice(0, 5).join(", "));
    }
    for (const [key, value] of Object.entries(obj)) {
      // Diviser les clés contenant des slashs
      const keyParts = key.split("/").filter(Boolean);

      // Cas spécial: 'entries' enveloppe des objets nommés -> on descend sans ajouter 'entries'
      if (keyParts.length === 1 && keyParts[0] === "entries" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const childKey of Object.keys(value)) {
          const childVal = value[childKey];
          traverse(childVal, [...path, childKey], depth + 1);
        }
        continue;
      }

      // Cas spécial: 'contents' est souvent un tableau d'objets { text: "..." }
      if (keyParts.length === 1 && keyParts[0] === "contents" && Array.isArray(value)) {
        // Si les éléments ont une propriété 'text', agréger leurs textes et créer une feuille au chemin courant
        const texts = [];
        for (const el of value) {
          if (el && typeof el === "object" && typeof el.text === "string") texts.push(el.text);
        }
        if (texts.length > 0) {
          const name = [...path].join("/");
          const text = texts.join("\n\n");
          entries.push({
            name,
            data: TEXT_ENCODER.encode(text),
            text,
            isText: isPrintableText(text),
            format: "json",
          });
          leafCount += texts.length;
          continue;
        }
        // Sinon, on parcourt les éléments normalement
        traverse(value, [...path, ...keyParts], depth + 1);
        continue;
      }

      // Cas général: ajouter les parties de la clé au chemin et descendre
      const newPath = [...path, ...keyParts];
      traverse(value, newPath, depth + 1);
    }
  }

  traverse(messagePack);

  console.debug("[extractMessagePackEntries] Traversal terminée. Feuilles totales:", leafCount);
  if (entries.length) {
    try {
      const sampleNames = entries.slice(0, 10).map((e) => e.name);
      const firstText = entries[0]?.text ? String(entries[0].text).substring(0, 200) : "";
      console.debug("[extractMessagePackEntries] Sample entry names:", sampleNames);
      console.debug("[extractMessagePackEntries] First entry text preview:", firstText);
    } catch (e) {
      console.debug("[extractMessagePackEntries] Erreur lors du logging d'echantillon:", e?.message || e);
    }
  }
  return entries && entries.length ? entries : null;
}

function parseCborResource(bytes, trace = null) {
  try {
    const { value, bytesRead } = decodeCbor(bytes);
    if (bytesRead <= 0) {
      if (trace) pushDebug(trace, "CBOR présent mais aucun octet consommé.");
      return null;
    }
    const entries = extractMessagePackEntries(value);
    if (trace) {
      if (entries && entries.length) {
        pushDebug(trace, `CBOR/MessagePack détecté: ${entries.length} entrée(s).`);
      } else {
        pushDebug(trace, "CBOR décodé mais aucune entrée MessagePack exploitable.");
      }
    }
    return entries && entries.length ? entries : null;
  } catch (error) {
    if (trace) pushDebug(trace, `Échec du décodage CBOR: ${error.message}`);
    return null;
  }
}

async function maybeDecompressZstd(bytes) {
  if (bytes.length < 4 || bytesToAscii(bytes, 0, 4) !== ZSTD_MAGIC) {
    return bytes;
  }
  try {
    const runtime = await getZstdRuntime();
    const dict = await loadZstdDictionary();
    try {
      const dctx = runtime.createDCtx();
      try {
        return runtime.decompressUsingDict(dctx, bytes, dict);
      } finally {
        if (typeof runtime.freeDCtx === "function") {
          runtime.freeDCtx(dctx);
        }
      }
    } catch (dictError) {
      // Fall back to plain decompression if the frame does not need the dict.
      const plain = runtime.decompress(bytes);
      if (plain.length > 0) return plain;
      throw dictError;
    }
  } catch (error) {
    throw new Error('Ce fichier commence par une couche Zstd, mais le décodeur Zstd Web n\'a pas pu être chargé. ' + error.message);
  }
}

function yaz0Decompress(src) {
  if (bytesToAscii(src, 0, 4) !== "Yaz0") return src;

  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const uncompressedSize = view.getUint32(4, false);
  const dest = new Uint8Array(uncompressedSize);

  let srcPos = 16;
  let dstPos = 0;
  let validBits = 0;
  let codeByte = 0;

  while (dstPos < uncompressedSize) {
    if (validBits === 0) {
      codeByte = src[srcPos++];
      validBits = 8;
    }

    if (codeByte & 0x80) {
      dest[dstPos++] = src[srcPos++];
    } else {
      const byte1 = src[srcPos++];
      const byte2 = src[srcPos++];
      const distance = ((byte1 & 0x0f) << 8) | byte2;
      let copyLength = byte1 >> 4;

      if (copyLength === 0) {
        copyLength = src[srcPos++] + 0x12;
      } else {
        copyLength += 2;
      }

      const copySource = dstPos - (distance + 1);
      for (let copyIndex = 0; copyIndex < copyLength; copyIndex++) {
        dest[dstPos++] = dest[copySource + copyIndex];
      }
    }

    codeByte <<= 1;
    validBits--;
  }

  return dest;
}

export async function parseSarc(input, options = {}) {
  const initialBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const trace = [];
  const debugEnabled = options.debug !== false;
  if (debugEnabled) {
    pushDebug(trace, `Entrée reçue: ${initialBytes.length} octets.`);
    pushDebug(trace, `Signature initiale: ${bytesToAscii(initialBytes, 0, Math.min(4, initialBytes.length)) || "<vide>"}`);
  }
  const bytes = await maybeDecompressZstd(initialBytes);
  if (debugEnabled && bytes !== initialBytes) {
    pushDebug(trace, `Décompression Zstd appliquée: ${bytes.length} octets après décompression.`);
  }

  let sarcOffset = -1;
  for (let index = 0; index <= bytes.length - 4; index++) {
    if (bytesToAscii(bytes, index, 4) === "SARC") {
      sarcOffset = index;
      break;
    }
  }

  if (debugEnabled) {
    pushDebug(trace, sarcOffset >= 0 ? `SARC trouvé à l'offset ${sarcOffset}.` : "Aucune signature SARC trouvée après décompression.");
  }

  if (sarcOffset < 0) {
    const cborEntries = parseCborResource(bytes, debugEnabled ? trace : null);
    if (cborEntries) {
      if (debugEnabled) {
        pushDebug(trace, `Retour d'entrées CBOR/MessagePack: ${cborEntries.length}.`);
      }
      cborEntries.debugTrace = trace;
      return cborEntries;
    }
    const error = new Error("SARC non trouvé");
    error.debugTrace = trace;
    throw error;
  }

  const sarcView = new DataView(bytes.buffer, bytes.byteOffset + sarcOffset, bytes.byteLength - sarcOffset);
  const bom = readUint16(sarcView, 6, false);
  const littleEndian = bom === 0xfffe;
  const headerSize = readUint16(sarcView, 4, littleEndian);
  const dataOffset = readUint32(sarcView, 12, littleEndian);

  if (debugEnabled) {
    pushDebug(trace, `SARC BOM=${bom.toString(16)} endian=${littleEndian ? "LE" : "BE"} headerSize=${headerSize} dataOffset=${dataOffset}.`);
  }

  const sfatOffset = sarcOffset + headerSize;
  if (bytesToAscii(bytes, sfatOffset, 4) !== "SFAT") {
    const error = new Error(`SFAT non trouvé à l'offset ${sfatOffset}`);
    error.debugTrace = trace;
    throw error;
  }

  const sfatView = new DataView(bytes.buffer, bytes.byteOffset + sfatOffset, bytes.byteLength - sfatOffset);
  const sfatHeaderSize = readUint16(sfatView, 4, littleEndian);
  const nodeCount = readUint16(sfatView, 6, littleEndian);

  if (sfatHeaderSize !== 0x000c) {
    const error = new Error(`SFAT header invalide: ${sfatHeaderSize.toString(16)}`);
    error.debugTrace = trace;
    throw error;
  }

  const entries = [];
  for (let index = 0; index < nodeCount; index++) {
    const nodeOffset = sfatOffset + 12 + index * 16;
    const nodeView = new DataView(bytes.buffer, bytes.byteOffset + nodeOffset, 16);
    const attributes = readUint32(nodeView, 4, littleEndian);
    const start = readUint32(nodeView, 8, littleEndian);
    const end = readUint32(nodeView, 12, littleEndian);
    entries.push({ start, end, attributes });
  }

  const sfntOffset = sfatOffset + sfatHeaderSize + nodeCount * 16;
  if (bytesToAscii(bytes, sfntOffset, 4) === "SFNT") {
    const sfntView = new DataView(bytes.buffer, bytes.byteOffset + sfntOffset, bytes.byteLength - sfntOffset);
    const sfntHeaderSize = readUint16(sfntView, 4, littleEndian);
    const stringBase = sfntOffset + sfntHeaderSize;

    for (let index = 0; index < entries.length; index++) {
      const attributes = entries[index].attributes;
      if ((attributes & 0x01000000) !== 0) {
        const nameOffsetUnits = attributes & 0x0000ffff;
        const nameOffset = stringBase + nameOffsetUnits * 4;
        const name = decodeString(bytes, nameOffset);
        entries[index].name = name || `file_${index}`;
      } else {
        entries[index].name = `file_${index}`;
      }
    }
  } else {
    if (debugEnabled) {
      pushDebug(trace, `SFNT absent à l'offset ${sfntOffset}; noms de fichiers anonymes.`);
    }
    for (let index = 0; index < entries.length; index++) {
      entries[index].name = `file_${index}`;
    }
  }

  const dataBase = sarcOffset + dataOffset;
  for (const entry of entries) {
    const raw = bytes.subarray(dataBase + entry.start, dataBase + entry.end);
    entry.data = bytesToAscii(raw, 0, 4) === "Yaz0" ? yaz0Decompress(raw) : raw;
    entry.text = TEXT_DECODER.decode(entry.data);
    entry.isText = isPrintableText(entry.text);
  }

  if (debugEnabled) {
    pushDebug(trace, `SARC extrait avec succès: ${entries.length} entrée(s).`);
    entries.debugTrace = trace;
  }

  return entries;
}
