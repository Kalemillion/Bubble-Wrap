import { parseZipArchive } from "./ZipArchive.js";
import { parseSarc } from "./Sarc.js";
import BubbleManager from "./BubbleManager.js";

const TEXT_ENCODER = new TextEncoder();

function sortTree(node) {
  if (!node?.children) return;
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
  for (const child of node.children) sortTree(child);
}

function stripMessageArchiveSuffix(fileName) {
  return fileName
    .replace(/\.product\.sarc$/i, "")
    .replace(/\.sarc$/i, "")
    .replace(/\.yaz0$/i, "");
}

function buildVirtualMessageTree(entries, rootName) {
  const root = { kind: "directory", name: rootName, children: [], virtual: true };
  console.debug("[buildVirtualMessageTree] Entrées reçues:", entries.length, "rootName:", rootName);

  let dirCount = 0;
  let fileCount = 0;

  for (const entry of entries) {
    const normalizedName = String(entry?.name || "unnamed").replaceAll("\\", "/").replace(/^\/+/, "");
    const parts = normalizedName.split("/").filter(Boolean);
    if (!parts.length) {
      console.debug("[buildVirtualMessageTree] Entrée sans parties:", entry?.name);
      continue;
    }

    if (fileCount < 5) {
      console.debug("[buildVirtualMessageTree] Chemin:", normalizedName, "→ parts:", parts.join("|"));
    }

    let node = root;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const isLeaf = index === parts.length - 1;
      if (isLeaf) {
        node.children.push({
          kind: "file",
          name: part,
          text: entry.text ?? "",
          data: entry.data instanceof Uint8Array ? entry.data : TEXT_ENCODER.encode(String(entry.text ?? "")),
          isText: true,
          format: entry.format || "json",
          virtual: true,
        });
        fileCount++;
      } else {
        let childDir = node.children.find((candidate) => candidate.kind === "directory" && candidate.name === part);
        if (!childDir) {
          childDir = { kind: "directory", name: part, children: [], virtual: true };
          node.children.push(childDir);
          dirCount++;
        }
        node = childDir;
      }
    }
  }

  console.debug("[buildVirtualMessageTree] Arborescence construite: dirs=" + dirCount + ", files=" + fileCount);
  sortTree(root);
  return root;
}

/** Renders a local folder selection as a VS Code-style explorer tree. */
export default class FolderExplorer {
  static openButtonElement = document.getElementById("open-folder-btn");
  static openZipButtonElement = document.getElementById("open-zip-btn");
  static statusElement = document.getElementById("workspace-status");
  static treeElement = document.getElementById("workspace-tree");
  static previewElement = document.getElementById("workspace-preview");
  static fileInputElement = document.getElementById("folder-file-input");
  static zipFileInputElement = document.getElementById("zip-file-input");
  static supportsDirectoryPicker = "showDirectoryPicker" in window;

  static {
    if (FolderExplorer.openZipButtonElement && FolderExplorer.zipFileInputElement) {
      FolderExplorer.openZipButtonElement.addEventListener("click", () => FolderExplorer.zipFileInputElement.click());
      FolderExplorer.zipFileInputElement.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;

        try {
          await FolderExplorer.renderZip(file);
        } catch (error) {
          console.error(error);
          FolderExplorer.statusElement.textContent = "Could not open that zip file.";
        }
      });
    }

    if (!FolderExplorer.supportsDirectoryPicker) {
      // If Directory Picker API is not available, attempt a file-input fallback
      const hasWebkitDirectory = !!FolderExplorer.fileInputElement && "webkitdirectory" in FolderExplorer.fileInputElement;
      if (!hasWebkitDirectory) {
        FolderExplorer.statusElement.textContent = "Folder browsing is not supported in this browser.";
        FolderExplorer.openButtonElement.disabled = true;
        FolderExplorer.openButtonElement.title = "This browser does not support folder selection.";
      } else {
        FolderExplorer.statusElement.textContent = "Use the folder button to select a folder (fallback).";
        FolderExplorer.openButtonElement.addEventListener("click", () => FolderExplorer.fileInputElement.click());
        FolderExplorer.fileInputElement.addEventListener("change", async (e) => {
          const files = Array.from(e.target.files || []);
          if (!files.length) return;
          FolderExplorer.clearPreview();
          FolderExplorer.currentZipArchive = null;
          const rootNode = FolderExplorer.buildTreeFromFiles(files);
          FolderExplorer.treeElement.replaceChildren();
          FolderExplorer.treeElement.appendChild(FolderExplorer.createNode(rootNode, true));
          FolderExplorer.statusElement.textContent = "Selected folder (fallback)";
        });
      }
    } else {
      FolderExplorer.openButtonElement.addEventListener("click", async () => {
        try {
          const rootHandle = await window.showDirectoryPicker({ mode: "read" });
          await FolderExplorer.renderRoot(rootHandle);
        } catch (error) {
          if (error?.name !== "AbortError") {
            console.error(error);
            FolderExplorer.statusElement.textContent = "Could not open that folder.";
          }
        }
      });
    }
  }

  static async renderRoot(rootHandle) {
    FolderExplorer.statusElement.textContent = rootHandle.name || "Workspace";
    FolderExplorer.treeElement.replaceChildren();
    FolderExplorer.clearPreview();
    FolderExplorer.currentZipArchive = null;
    const rootNode = await FolderExplorer.readDirectory(rootHandle);
    FolderExplorer.treeElement.appendChild(FolderExplorer.createNode(rootNode, true));
  }

  static async renderZip(file) {
    FolderExplorer.statusElement.textContent = file.name || "ZIP";
    FolderExplorer.treeElement.replaceChildren();
    FolderExplorer.clearPreview();
    const parsed = parseZipArchive(await file.arrayBuffer(), file.name.replace(/\.zip$/i, "") || "ZIP");
    FolderExplorer.currentZipArchive = parsed; // { root, entries, getFileData }
    FolderExplorer.treeElement.appendChild(FolderExplorer.createNode(parsed.root, true, ""));
  }

  /**
   * Builds a nested directory/file tree from a FileList (webkitRelativePath)
   * @param {File[]} files
   * @returns {Object} root node
   */
  static buildTreeFromFiles(files) {
    const root = { kind: "directory", name: "Workspace", children: [] };
    for (const file of files) {
      const rel = file.webkitRelativePath || file.name;
      const parts = rel.split(/\\|\//).filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        if (isFile) {
          node.children.push({ kind: "file", name: part, file });
        } else {
          let childDir = node.children.find((c) => c.kind === "directory" && c.name === part);
          if (!childDir) {
            childDir = { kind: "directory", name: part, children: [] };
            node.children.push(childDir);
          }
          node = childDir;
        }
      }
    }
    sortTree(root);
    return root;
  }

  static async readDirectory(handle) {
    const children = [];
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === "directory") {
        children.push(await FolderExplorer.readDirectory(entry));
      } else {
        children.push({ kind: "file", name, fileHandle: entry });
      }
    }

    children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });

    return {
      kind: "directory",
      name: handle.name,
      children
    };
  }

  static createNode(node, isRoot = false, parentPath = "") {
    if (node.kind === "file") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tree-node tree-file";
      button.setAttribute("aria-label", node.name);
      button.title = parentPath || node.name;
      button.textContent = node.name;
      button.dataset.fullpath = parentPath || node.name;
      button.addEventListener("click", async (e) => {
        e.stopPropagation();
        await FolderExplorer.onFileClick(button.dataset.fullpath, button, node);
      });
      return button;
    }

    const details = document.createElement("details");
    details.className = "tree-folder";
    details.open = isRoot;

    const summary = document.createElement("summary");
    summary.className = "tree-node tree-folder-summary";
    summary.title = node.name || "Workspace";
    summary.textContent = node.name || "Workspace";
    details.appendChild(summary);

    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-children";
    for (const child of node.children) {
      const childPath = parentPath ? `${parentPath}/${child.name}` : child.name;
      childrenContainer.appendChild(FolderExplorer.createNode(child, false, childPath));
    }
    details.appendChild(childrenContainer);

    return details;
  }

  static async onFileClick(fullPath, buttonElement, sourceNode = null) {
    try {
      if (sourceNode?.virtual && sourceNode.kind === "file") {
        FolderExplorer.renderPreview(buttonElement.textContent || fullPath, sourceNode.text || "", true);
        return;
      }

      if (sourceNode && Array.isArray(sourceNode.children)) {
        FolderExplorer.renderPreview(buttonElement.textContent || fullPath, `Dossier: ${fullPath}`);
        return;
      }

      const sourceBytes = await FolderExplorer.getNodeBytes(sourceNode, fullPath);

      if (/\.sarc$/i.test(fullPath) || /\.product\.sarc$/i.test(fullPath)) {
        FolderExplorer.statusElement.textContent = `Opening ${fullPath}...`;
        const data = sourceBytes || await FolderExplorer.getZipFileData(fullPath);
        if (!data) {
          FolderExplorer.statusElement.textContent = `No data for ${fullPath}`;
          return;
        }

        const entries = await parseSarc(data, { debug: true });
        const isMessagePack = entries.some((entry) => entry.format === "json");
        const archiveLabel = stripMessageArchiveSuffix(buttonElement.textContent || fullPath.split(/[\\/]/).pop() || fullPath);
        const treeRoot = isMessagePack ? buildVirtualMessageTree(entries, archiveLabel) : null;

        const details = document.createElement("details");
        details.className = "tree-folder";
        details.open = true;

        const summary = document.createElement("summary");
        summary.className = "tree-node tree-folder-summary";
        summary.title = buttonElement.title;
        summary.textContent = archiveLabel;
        details.appendChild(summary);

        const childrenContainer = document.createElement("div");
        childrenContainer.className = "tree-children";
        if (treeRoot) {
          for (const child of treeRoot.children) {
            const childPath = archiveLabel ? `${archiveLabel}/${child.name}` : child.name;
            childrenContainer.appendChild(FolderExplorer.createNode(child, false, childPath));
          }
        } else {
          for (const entry of entries) {
            const childButton = document.createElement("button");
            childButton.type = "button";
            childButton.className = "tree-node tree-file";
            const entryName = entry.name || "unnamed";
            childButton.textContent = entryName;
            childButton.title = entry.format === "json" ? `${entryName} [JSON]` : entryName;
            childButton.addEventListener("click", (event) => {
              event.stopPropagation();
              FolderExplorer.renderPreview(entryName, entry.text, true);
            });
            childrenContainer.appendChild(childButton);
          }
        }

        details.appendChild(childrenContainer);
        buttonElement.replaceWith(details);
        FolderExplorer.statusElement.textContent = `Expanded ${fullPath}`;
        FolderExplorer.renderPreview(
          fullPath,
          `${entries.length} entrées extraites${isMessagePack ? " (MessagePack JSON)" : ""}. Sélectionnez une entrée pour afficher son texte.`,
          true,
        );
        return;
      }

      const data = sourceBytes || await FolderExplorer.getZipFileData(fullPath);
      if (!data) {
        FolderExplorer.renderPreview(buttonElement.textContent || fullPath, "Fichier introuvable.");
        return;
      }

      const text = new TextDecoder("utf-8").decode(data);
      FolderExplorer.renderPreview(buttonElement.textContent || fullPath, text, true);
    } catch (err) {
      console.error(err);
      FolderExplorer.statusElement.textContent = `Failed to open ${fullPath}`;
      const debugTrace = Array.isArray(err?.debugTrace) ? err.debugTrace : null;
      const previewText = debugTrace && debugTrace.length
        ? `${err?.message || String(err)}\n\n--- Debug trace ---\n${debugTrace.join("\n")}`
        : err?.message || String(err);
      FolderExplorer.renderPreview(fullPath, previewText, false);
    }
  }

  static async getZipFileData(fullPath) {
    if (!FolderExplorer.currentZipArchive) return null;
    return await FolderExplorer.currentZipArchive.getFileData(fullPath);
  }

  static async getNodeBytes(sourceNode, fullPath) {
    if (!sourceNode || sourceNode.kind !== "file") return null;

    if (sourceNode.fileHandle?.getFile) {
      return new Uint8Array(await (await sourceNode.fileHandle.getFile()).arrayBuffer());
    }

    if (sourceNode.file?.arrayBuffer) {
      return new Uint8Array(await sourceNode.file.arrayBuffer());
    }

    if (sourceNode.data instanceof Uint8Array) {
      return sourceNode.data;
    }

    return null;
  }

  static clearPreview() {
    if (!FolderExplorer.previewElement) return;
    FolderExplorer.previewElement.textContent = "";
    FolderExplorer.previewElement.dataset.mode = "empty";
  }

  static renderPreview(title, content, isText = false) {
    if (!FolderExplorer.previewElement) return;
    FolderExplorer.previewElement.dataset.mode = isText ? "text" : "info";
    FolderExplorer.previewElement.replaceChildren();

    const heading = document.createElement("div");
    heading.className = "preview-title";
    heading.textContent = title;
    FolderExplorer.previewElement.appendChild(heading);
    const body = document.createElement("pre");
    body.className = "preview-body";
    body.textContent = content;
    FolderExplorer.previewElement.appendChild(body);

    if (isText) {
      const btnContainer = document.createElement("div");
      btnContainer.className = "preview-actions";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn-validate-entry";
      addBtn.textContent = "Valider et ajouter";
      addBtn.addEventListener("click", () => {
        console.debug('[FolderExplorer] addBtn clicked for', title);
        // Determine text to insert into bubble
        let textToInsert = content;
        try {
          const parsed = JSON.parse(content);
          // If parsed is a string, use it. If it's an object, try to extract a readable text.
          if (typeof parsed === "string") {
            textToInsert = parsed;
          } else if (parsed && typeof parsed === "object") {
            // Heuristics: if object has 'text', 'contents' or is a simple map, pick meaningful value
            if (typeof parsed.text === "string") {
              textToInsert = parsed.text;
            } else if (Array.isArray(parsed.contents)) {
              const texts = parsed.contents.map((c) => (c && typeof c.text === "string" ? c.text : JSON.stringify(c))).filter(Boolean);
              if (texts.length) textToInsert = texts.join("\n\n");
            } else {
              // Default: pretty-print a compact JSON
              textToInsert = JSON.stringify(parsed, null, 2);
            }
          }
        } catch (e) {
          // not JSON, keep as-is
        }

        // If parsed JSON contains an `entries` map, ask user which entries to open
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
            console.debug('[FolderExplorer] parsed entries found, opening selector');
            FolderExplorer.showEntrySelector(parsed.entries, title);
            return;
          }
        } catch (e) {
          console.debug('[FolderExplorer] content not JSON or parse failed');
        }

        // Insert as a new bubble at end
        let parent = BubbleManager.bubbles[BubbleManager.bubbles.length - 1];
        BubbleManager.addBubble(parent, textToInsert);
      });
      btnContainer.appendChild(addBtn);
      FolderExplorer.previewElement.appendChild(btnContainer);
    }
  }

  static showEntrySelector(entriesObj, baseTitle) {
    if (!FolderExplorer.previewElement) return;
    console.debug('[FolderExplorer] showEntrySelector', Object.keys(entriesObj).length);
    // Create modal overlay attached to body to avoid nesting/click issues
    const overlay = document.createElement("div");
    overlay.className = "entry-selector-overlay";
    overlay.style.position = "fixed";
    overlay.style.left = 0;
    overlay.style.top = 0;
    overlay.style.right = 0;
    overlay.style.bottom = 0;
    overlay.style.background = "rgba(0,0,0,0.4)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = 10000;

    const panel = document.createElement("div");
    panel.className = "entry-selector-panel";
    panel.style.background = "#fff";
    panel.style.padding = "12px";
    panel.style.maxHeight = "70%";
    panel.style.overflow = "auto";
    panel.style.minWidth = "320px";
    panel.style.borderRadius = "6px";
    panel.style.zIndex = 10001;

    const heading = document.createElement("div");
    heading.style.fontWeight = "600";
    heading.style.marginBottom = "8px";
    heading.textContent = `Sélectionner les entrées à ajouter (${baseTitle})`;
    panel.appendChild(heading);

    const list = document.createElement("div");
    list.style.display = "grid";
    list.style.gridTemplateColumns = "1fr 1fr";
    list.style.gap = "6px";

    const keys = Object.keys(entriesObj || {}).sort();
    for (const k of keys) {
      const item = document.createElement("label");
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "8px";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = k;
      cb.checked = false;
      const span = document.createElement("span");
      span.textContent = k;
      item.appendChild(cb);
      item.appendChild(span);
      list.appendChild(item);
    }
    panel.appendChild(list);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "10px";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Annuler";
    cancelBtn.addEventListener("click", () => overlay.remove());

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "Appliquer";
    applyBtn.addEventListener("click", () => {
      const checked = Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map((n) => n.value);
      if (!checked.length) {
        alert("Sélectionne au moins une entrée.");
        return;
      }
      // Insert selected entries as bubbles
      let parent = BubbleManager.bubbles[BubbleManager.bubbles.length - 1];
      for (const name of checked) {
        const val = entriesObj[name];
        let text = "";
        if (val && typeof val === "object") {
          if (typeof val.text === "string") text = val.text;
          else if (Array.isArray(val.contents)) {
            const texts = val.contents.map((c) => (c && typeof c.text === "string" ? c.text : JSON.stringify(c))).filter(Boolean);
            text = texts.join("\n\n");
          } else {
            text = JSON.stringify(val, null, 2);
          }
        } else {
          text = String(val);
        }
        BubbleManager.addBubble(parent, `${name}: ${text}`);
        // update parent to newly created bubble
        const pIndex = parent.getIndex();
        parent = BubbleManager.bubbles[pIndex + 1] || parent;
      }
      overlay.remove();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(applyBtn);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }
}