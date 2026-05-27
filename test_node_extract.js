// Test local pour valider extractMessagePackEntries + buildVirtualMessageTree
// Usage: node test_node_extract.js

const { TextEncoder } = require('util');
const TEXT_ENCODER = new TextEncoder();

function isPrintableText(t) {
  return typeof t === 'string' && t.length > 0;
}

function decodeJsonPretty(v) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch (e) {
    return String(v);
  }
}

function extractMessagePackEntries(resource) {
  const mergeable = resource?.Mergeable;
  const messagePack = mergeable?.MessagePack ?? resource?.MessagePack;
  console.debug("[extractMessagePackEntries] messagePack exists:", !!messagePack, "type:", typeof messagePack, "isArray:", Array.isArray(messagePack));
  if (!messagePack || typeof messagePack !== "object" || Array.isArray(messagePack)) {
    console.debug("[extractMessagePackEntries] Rejet: messagePack invalide.");
    return null;
  }

  const entries = [];
  let leafCount = 0;

  function traverse(obj, path = [], depth = 0) {
    if (obj === null) return;
    if (Array.isArray(obj)) {
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
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const keyParts = key.split("/").filter(Boolean);

      if (keyParts.length === 1 && keyParts[0] === "entries" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const childKey of Object.keys(value)) {
          const childVal = value[childKey];
          traverse(childVal, [...path, childKey], depth + 1);
        }
        continue;
      }

      if (keyParts.length === 1 && keyParts[0] === "contents" && Array.isArray(value)) {
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
        traverse(value, [...path, ...keyParts], depth + 1);
        continue;
      }

      const newPath = [...path, ...keyParts];
      traverse(value, newPath, depth + 1);
    }
  }

  traverse(messagePack);
  return entries && entries.length ? entries : null;
}

function buildVirtualMessageTree(entries, rootName) {
  const root = { kind: "directory", name: rootName, children: [] };
  for (const entry of entries) {
    const normalizedName = String(entry?.name || "unnamed").replaceAll('\\', '/').replace(/^\/+/, '');
    const parts = normalizedName.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        node.children.push({ kind: 'file', name: part, text: entry.text });
      } else {
        let child = node.children.find(c => c.kind === 'directory' && c.name === part);
        if (!child) { child = { kind: 'directory', name: part, children: [] }; node.children.push(child); }
        node = child;
      }
    }
  }
  return root;
}

function printTree(node, indent = '') {
  if (!node) return;
  if (node.kind === 'file') {
    console.log(indent + '- ' + node.name);
    return;
  }
  console.log(indent + (node.name || 'root') + '/');
  for (const c of node.children) printTree(c, indent + '  ');
}

// Exemple minimal basé sur l'entrée fournie (LocationMarker)
const LocationMarker = {
  "atr1_unknown": 0,
  "entries": {
    "AncientLaboRuins": { "contents": [{ "text": "Ruines du laboratoire de Toal" }] },
    "Blacksmith": { "contents": [{ "text": "Forgeron" }] },
    "CaveHyruleOuter": { "contents": [{ "text": "Grotte de la Girouette" }] }
  },
  "group_count": 101
};

const resource = { MessagePack: { 'StaticMsg/LocationMarker': LocationMarker } };
const entries = extractMessagePackEntries(resource);
console.log('Entries count:', entries?.length || 0);
if (entries) {
  console.log('Sample names:');
  for (let i = 0; i < Math.min(entries.length, 20); i++) console.log('  ', entries[i].name);
}

const tree = buildVirtualMessageTree(entries || [], 'Msg_EUfr');
console.log('\nConstructed tree:');
printTree(tree);
