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
      console.debug('[FolderExplorer.onFileClick] fullPath:', fullPath, 'sourceNode.kind:', sourceNode?.kind, 'virtual:', !!sourceNode?.virtual);
      // Auto-select bubble type based on file path
      FolderExplorer.autoSelectBubbleType(fullPath);

      if (sourceNode?.virtual && sourceNode.kind === "file") {
        console.debug('[FolderExplorer.onFileClick] virtual file clicked:', buttonElement.textContent || fullPath);
        // Try to parse the virtual file text and expand into a virtual folder if it contains `entries`
        try {
          const text = sourceNode.text || "";
          const parsed = text ? JSON.parse(text) : null;
          if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
            console.debug('[FolderExplorer.onFileClick] virtual JSON contains entries, expanding...');
            const details = document.createElement("details");
            details.className = "tree-folder";
            details.open = true;

            const summary = document.createElement("summary");
            summary.className = "tree-node tree-folder-summary";
            summary.title = buttonElement.title;
            summary.textContent = buttonElement.textContent || fullPath.split(/[\\/]/).pop() || fullPath;
            details.appendChild(summary);

            const childrenContainer = document.createElement("div");
            childrenContainer.className = "tree-children";
            const entriesKeys = Object.keys(parsed.entries || {}).sort();
            for (const entryName of entriesKeys) {
              const childButton = document.createElement("button");
              childButton.type = "button";
              childButton.className = "tree-node tree-file";
              childButton.textContent = entryName;
              childButton.title = `${entryName} [entry]`;
              childButton.addEventListener("click", (event) => {
                event.stopPropagation();
                const entry = parsed.entries[entryName];
                let entryText = "";
                try {
                  if (entry && typeof entry === "object" && Array.isArray(entry.contents)) {
                    const parts = entry.contents.map((c) => {
                      if (c && typeof c === "object") {
                        if (typeof c.text === "string") return c.text;
                        if (c.control) return JSON.stringify(c.control);
                        return JSON.stringify(c);
                      }
                      return String(c);
                    }).filter(Boolean);
                    entryText = parts.join("\n\n");
                  } else {
                    entryText = JSON.stringify(entry, null, 2);
                  }
                } catch (e) {
                  entryText = String(entry);
                }
                FolderExplorer.renderPreview(entryName, entryText, true);
              });
              // Add the entry button and an adjacent "Ajouter" button for quick insertion
              const wrapper = document.createElement("div");
              wrapper.className = "tree-file-row";
              wrapper.style.display = "flex";
              wrapper.style.gap = "6px";
              wrapper.style.alignItems = "center";
              wrapper.appendChild(childButton);

              const addBtn = document.createElement("button");
              addBtn.type = "button";
              addBtn.className = "tree-node tree-file add-entry-btn";
              addBtn.textContent = "Ajouter";
              addBtn.title = `Ajouter ${entryName}`;
              addBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const entry = parsed.entries[entryName];
                FolderExplorer.insertEntryObject(entry, entryName);
              });
              wrapper.appendChild(addBtn);
              childrenContainer.appendChild(wrapper);
            }

            details.appendChild(childrenContainer);
            console.debug('[FolderExplorer.onFileClick] replacing virtual file button with details for', fullPath);
            buttonElement.replaceWith(details);
            FolderExplorer.statusElement.textContent = `Expanded ${fullPath}`;
            FolderExplorer.renderPreview(
              fullPath,
              `${Object.keys(parsed.entries || {}).length} entrées extraites. Sélectionnez une entrée pour afficher son texte.`,
              true,
            );
            return;
          }
        } catch (e) {
          console.debug('[FolderExplorer.onFileClick] virtual file parse failed:', e?.message || e);
        }

        // Fallback: render as plain preview
        FolderExplorer.renderPreview(buttonElement.textContent || fullPath, sourceNode.text || "", true);
        return;
      }

      if (sourceNode && Array.isArray(sourceNode.children)) {
        FolderExplorer.renderPreview(buttonElement.textContent || fullPath, `Dossier: ${fullPath}`);
        return;
      }

      const sourceBytes = await FolderExplorer.getNodeBytes(sourceNode, fullPath);
      console.debug('[FolderExplorer.onFileClick] got sourceBytes:', sourceBytes ? sourceBytes.length : null);

      if (/\.sarc$/i.test(fullPath) || /\.product\.sarc$/i.test(fullPath)) {
        console.debug('[FolderExplorer.onFileClick] detected SARC:', fullPath);
        FolderExplorer.statusElement.textContent = `Opening ${fullPath}...`;
        const data = sourceBytes || await FolderExplorer.getZipFileData(fullPath);
        if (!data) {
          FolderExplorer.statusElement.textContent = `No data for ${fullPath}`;
          return;
        }

        const entries = await parseSarc(data, { debug: true });
        console.debug('[FolderExplorer.onFileClick] parseSarc returned', entries.length, 'entries');
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
          console.debug('[FolderExplorer.onFileClick] built virtual tree root with', treeRoot.children.length, 'children');
          for (const child of treeRoot.children) {
            const childPath = archiveLabel ? `${archiveLabel}/${child.name}` : child.name;
            childrenContainer.appendChild(FolderExplorer.createNode(child, false, childPath));
          }
        } else {
          console.debug('[FolderExplorer.onFileClick] adding', entries.length, 'child buttons from SARC entries');
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
            // For SARC entries, also provide an "Ajouter" button
            const wrapper = document.createElement("div");
            wrapper.className = "tree-file-row";
            wrapper.style.display = "flex";
            wrapper.style.gap = "6px";
            wrapper.style.alignItems = "center";
            wrapper.appendChild(childButton);

            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.className = "tree-node tree-file add-entry-btn";
            addBtn.textContent = "Ajouter";
            addBtn.title = `Ajouter ${entryName}`;
            addBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              // entry may be a parsed SARC entry with .text and maybe .data
              // If format is json, try to parse and insert
              if (entry.format === "json") {
                try {
                  const parsed = entry.text ? JSON.parse(entry.text) : null;
                  if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
                    // If it's a message archive root, open selector for its entries
                    FolderExplorer.showEntrySelector(parsed.entries, entryName);
                    return;
                  }
                  FolderExplorer.insertEntryObject(parsed || entry.text || entryName, entryName);
                  return;
                } catch (e) {
                  // fallback
                }
              }
              FolderExplorer.insertEntryObject(entry.text || entryName, entryName);
            });
            wrapper.appendChild(addBtn);
            childrenContainer.appendChild(wrapper);
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
      console.debug('[FolderExplorer.onFileClick] decoded text length:', text.length);
      // If this file is a JSON that contains an `entries` map, expand it into a virtual folder
      try {
        const parsed = JSON.parse(text);
        console.debug('[FolderExplorer.onFileClick] parsed JSON, keys:', Object.keys(parsed || {}).slice(0, 10));
        if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
          console.debug('[FolderExplorer.onFileClick] JSON contains entries, count=', Object.keys(parsed.entries || {}).length);
          const details = document.createElement("details");
          details.className = "tree-folder";
          details.open = true;

          const summary = document.createElement("summary");
          summary.className = "tree-node tree-folder-summary";
          summary.title = buttonElement.title;
          summary.textContent = buttonElement.textContent || fullPath.split(/[\\/]/).pop() || fullPath;
          details.appendChild(summary);

          const childrenContainer = document.createElement("div");
          childrenContainer.className = "tree-children";
          const entriesKeys = Object.keys(parsed.entries || {}).sort();
          console.debug('[FolderExplorer.onFileClick] entriesKeys sample:', entriesKeys.slice(0, 10));
          for (const entryName of entriesKeys) {
            const childButton = document.createElement("button");
            childButton.type = "button";
            childButton.className = "tree-node tree-file";
            childButton.textContent = entryName;
            childButton.title = `${entryName} [entry]`;
            childButton.addEventListener("click", (event) => {
              event.stopPropagation();
              const entry = parsed.entries[entryName];
              console.debug('[FolderExplorer.onFileClick] clicked entry', entryName, 'entry.contents?.length=', Array.isArray(entry?.contents) ? entry.contents.length : 'n/a');
              let entryText = "";
              try {
                if (entry && typeof entry === "object" && Array.isArray(entry.contents)) {
                  const parts = entry.contents.map((c) => {
                    if (c && typeof c === "object") {
                      if (typeof c.text === "string") return c.text;
                      if (c.control) return JSON.stringify(c.control);
                      return JSON.stringify(c);
                    }
                    return String(c);
                  }).filter(Boolean);
                  entryText = parts.join("\n\n");
                } else {
                  entryText = JSON.stringify(entry, null, 2);
                }
              } catch (e) {
                entryText = String(entry);
              }
              FolderExplorer.renderPreview(entryName, entryText, true);
            });
            // Add adjacent "Ajouter" button for quick insertion
            const wrapper = document.createElement("div");
            wrapper.className = "tree-file-row";
            wrapper.style.display = "flex";
            wrapper.style.gap = "6px";
            wrapper.style.alignItems = "center";
            wrapper.appendChild(childButton);

            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.className = "tree-node tree-file add-entry-btn";
            addBtn.textContent = "Ajouter";
            addBtn.title = `Ajouter ${entryName}`;
            addBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              const entry = parsed.entries[entryName];
              FolderExplorer.insertEntryObject(entry, entryName);
            });
            wrapper.appendChild(addBtn);
            childrenContainer.appendChild(wrapper);
          }

          details.appendChild(childrenContainer);
          console.debug('[FolderExplorer.onFileClick] replacing button element with virtual details for', fullPath);
          buttonElement.replaceWith(details);
          FolderExplorer.statusElement.textContent = `Expanded ${fullPath}`;
          FolderExplorer.renderPreview(
            fullPath,
            `${Object.keys(parsed.entries || {}).length} entrées extraites. Sélectionnez une entrée pour afficher son texte.`,
            true,
          );
          return;
        }
      } catch (e) {
        // not JSON or parse failed — fall back to plain text preview
      }

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

        // Insert using the shared helper so control nodes are handled consistently.
        try {
          const parsedAgain = JSON.parse(content);
          if (parsedAgain && typeof parsedAgain === "object" && Array.isArray(parsedAgain.contents)) {
            FolderExplorer.insertEntryObject(parsedAgain, title);
          } else {
            FolderExplorer.insertEntryObject(textToInsert, title);
          }
        } catch (e) {
          FolderExplorer.insertEntryObject(textToInsert, title);
        }
      });
      btnContainer.appendChild(addBtn);
      FolderExplorer.previewElement.appendChild(btnContainer);
    }
  }

  static insertEntryObject(entryVal, entryName) {
    // Insert a single entry (object or text) into the bubble list
    let parent = BubbleManager.bubbles[BubbleManager.bubbles.length - 1];
    try {
      if (entryVal && typeof entryVal === "object" && Array.isArray(entryVal.contents)) {
        let pendingControls = [];
        for (const c of entryVal.contents) {
          if (c && typeof c === "object" && c.control) {
            pendingControls.push(c.control);
            continue;
          }
          let part = "";
          if (c && typeof c === "object") {
            if (typeof c.text === "string") part = c.text;
            else part = JSON.stringify(c);
          } else {
            part = String(c);
          }
          BubbleManager.addBubble(parent, part);
          const pIndex = parent.getIndex();
          const newParent = BubbleManager.bubbles[pIndex + 1] || parent;
          for (const ctrl of pendingControls) {
            const handled = FolderExplorer.tryApplyKnownControl(newParent, ctrl);
            if (!handled) {
              try {
                newParent.insertNonTextNode({ rawControl: ctrl }, () => {});
              } catch (e) {
                BubbleManager.addBubble(newParent, JSON.stringify(ctrl));
              }
            }
          }
          pendingControls = [];
          parent = newParent;
        }
      } else {
        let text = "";
        if (entryVal && typeof entryVal === "object") {
          if (typeof entryVal.text === "string") text = entryVal.text;
          else text = JSON.stringify(entryVal, null, 2);
        } else {
          text = String(entryVal || entryName || "");
        }
        BubbleManager.addBubble(parent, text);
      }
    } catch (e) {
      const fallback = typeof entryVal === "string" ? entryVal : JSON.stringify(entryVal);
      BubbleManager.addBubble(parent, fallback);
    }
  }

  static tryApplyKnownControl(targetBubble, controlObj) {
    const kind = controlObj?.kind;
    if (kind === "set_colour") {
      const color = controlObj?.colour || "white";
      FolderExplorer.applyColorToBubble(targetBubble, color);
      return true;
    }
    if (kind === "reset_colour") {
      FolderExplorer.applyColorToBubble(targetBubble, "white");
      return true;
    }
    return false;
  }

  static applyColorToBubble(targetBubble, color) {
    const line = targetBubble?.bubbleContentElement?.firstElementChild;
    if (!line) return;

    // Convert existing line text into a color span so export uses native data-color logic.
    if (line.children.length === 0) {
      const span = document.createElement("span");
      span.setAttribute("data-color", color);
      span.textContent = line.textContent || "";
      line.textContent = "";
      line.appendChild(span);
      return;
    }

    line.querySelectorAll("span").forEach((span) => {
      span.setAttribute("data-color", color);
    });
  }

  static autoSelectBubbleType(fullPath) {
    console.debug('[FolderExplorer.autoSelectBubbleType] fullPath:', fullPath);
    
    // Map file path patterns to bubble type values
    const pathToTypeMap = {
      "ActorType": "item",
      "DemoMsg": "dialogue",
      "EventFlowMsg": "sign",
      "LayoutMsg": "sign",
      "QuestMsg": "questBOTW",
      "ShoutMsg": "dialogue",
      "StaticMsg": "sign",
      "Tips": "tip"
    };

    // Extract all path segments and find the first one that matches a known type
    const pathSegments = fullPath.split(/[\/\\]/).filter(Boolean);
    console.debug('[FolderExplorer.autoSelectBubbleType] pathSegments:', pathSegments);
    if (!pathSegments.length) {
      console.debug('[FolderExplorer.autoSelectBubbleType] no path segments found, returning');
      return;
    }

    // Look for the first segment that matches a key in pathToTypeMap
    let selectedType = null;
    let matchedSegment = null;
    for (const segment of pathSegments) {
      if (pathToTypeMap[segment]) {
        matchedSegment = segment;
        selectedType = pathToTypeMap[segment];
        break;
      }
    }
    
    console.debug('[FolderExplorer.autoSelectBubbleType] matchedSegment:', matchedSegment, 'selectedType:', selectedType);
    if (!selectedType) {
      console.debug('[FolderExplorer.autoSelectBubbleType] no mapping found in path segments');
      return;
    }

    // Update the select element
    const selectEl = document.getElementById("bubble-type");
    console.debug('[FolderExplorer.autoSelectBubbleType] selectEl:', selectEl);
    if (!selectEl) {
      console.debug('[FolderExplorer.autoSelectBubbleType] select element not found');
      return;
    }

    const currentValue = selectEl.value;
    console.debug('[FolderExplorer.autoSelectBubbleType] currentValue:', currentValue, 'newValue:', selectedType);
    if (currentValue === selectedType) {
      console.debug('[FolderExplorer.autoSelectBubbleType] no change needed');
      return;
    }

    selectEl.value = selectedType;
    console.debug('[FolderExplorer.autoSelectBubbleType] changed select to:', selectedType);
    // Trigger change event to apply type update via BubbleManager
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    console.debug('[FolderExplorer.autoSelectBubbleType] dispatched change event');
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
      // Insert selected entries as bubbles using shared helper.
      for (const name of checked) {
        const val = entriesObj[name];
        FolderExplorer.insertEntryObject(val, name);
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