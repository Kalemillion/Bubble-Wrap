import BubbleManager from "./BubbleManager.js";
import UKMMParser from "./UKMMParser.js";

/** Manages the UKMM JSON import side panel and tree UI. */
export default class UKMMImportUI {
  /** @type {Object|null} The parsed JSON data from the loaded file. */
  static data = null;
  /** @type {string|null} The filename of the loaded file (for display). */
  static filename = null;
  /** @type {string|null} Language code extracted from the filename (e.g. "EUfr"). */
  static langCode = null;

  /** Initialises the import button and hidden file input. */
  static init() {
    const importBtn = document.getElementById("ukmm-import-btn");
    const fileInput = document.getElementById("ukmm-file-input");

    importBtn.addEventListener("click", () => {
      if (UKMMImportUI.data) {
        // Data already loaded — re-open the tree panel
        UKMMImportUI.renderTree();
      } else {
        fileInput.click();
      }
    });

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      UKMMImportUI.loadFile(file);
      // Reset so the same file can be re-selected
      fileInput.value = "";
    });

    document.getElementById("ukmm-import-close").addEventListener("click", () => {
      UKMMImportUI.closePanel();
    });

    document.getElementById("ukmm-import-change").addEventListener("click", () => {
      UKMMImportUI.closePanel();
      UKMMImportUI.reset();
      document.getElementById("ukmm-file-input").click();
    });
  }

  /**
   * Reads a ukmmsg2json file, validates it, and shows the entry tree.
   * @param {File} file The JSON file to load.
   */
  static async loadFile(file) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      // Validate expected structure
      if (!json.entries || typeof json.entries !== "object") {
        UKMMImportUI.showError("This doesn't look like a valid ukmmsg2json file. Expected top-level field: entries.");
        return;
      }
      if (Object.keys(json.entries).length === 0) {
        UKMMImportUI.showError("The file has no entries to import.");
        return;
      }

      UKMMImportUI.data = json;
      UKMMImportUI.filename = file.name;
      // Extract language code from filename, e.g. "Msg_EUfr.product.json" → "fr"
      const langMatch = file.name.match(/Msg_[A-Z]{2}([a-z]{2})/);
      UKMMImportUI.langCode = langMatch ? langMatch[1] : null;
      // Switch button to "Browse entries" mode
      const btn = document.getElementById("ukmm-import-btn");
      btn.textContent = "Browse entries";
      btn.title = "Browse imported UKMM entries";
      UKMMImportUI.renderTree();
    } catch (err) {
      UKMMImportUI.showError(`Failed to read file: ${err.message}`);
    }
  }

  /** Renders the entry tree in the side panel. */
  static renderTree() {
    const data = UKMMImportUI.data;
    if (!data) return;

    const panel = document.getElementById("ukmm-import-panel");
    const title = panel.querySelector(".ukmm-import-title");
    const tree = panel.querySelector(".ukmm-import-tree");
    const countBar = panel.querySelector(".ukmm-import-count");

    const lang = data.language ? `${data.language} — ` : "";
    title.textContent = `${lang}${UKMMImportUI.filename}`;
    const count = Object.keys(data.entries).length;
    countBar.textContent = `${count} section${count !== 1 ? "s" : ""}`;

    // Build a nested tree from paths like "ActorType/ArmorHead"
    const rootMap = new Map(); // top-level name → Map<sub-name, entries>

    for (const [sectionName, entries] of Object.entries(data.entries)) {
      const slash = sectionName.indexOf("/");
      const top = slash === -1 ? sectionName : sectionName.slice(0, slash);
      const sub = slash === -1 ? "" : sectionName.slice(slash + 1);

      if (!rootMap.has(top)) rootMap.set(top, new Map());
      rootMap.get(top).set(sub, entries);
    }

    tree.innerHTML = "";
    for (const [topName, subMap] of rootMap) {
      const topEl = document.createElement("details");
      topEl.classList.add("ukmm-section");
      topEl.open = false;

      const topSummary = document.createElement("summary");
      topSummary.classList.add("ukmm-section-summary");
      const totalEntries = [...subMap.values()].reduce((sum, e) => sum + Object.keys(e).length, 0);
      topSummary.textContent = `${topName} (${totalEntries})`;
      topEl.appendChild(topSummary);

      for (const [subName, entries] of subMap) {
        if (subName) {
          // Has a sub-path — create a nested group
          const subEl = document.createElement("details");
          subEl.classList.add("ukmm-section", "ukmm-subsection");
          subEl.open = false;

          const subSummary = document.createElement("summary");
          subSummary.classList.add("ukmm-section-summary");
          subSummary.textContent = `${subName} (${Object.keys(entries).length})`;
          subEl.appendChild(subSummary);

          UKMMImportUI.appendEntryButtons(subEl, entries);
          topEl.appendChild(subEl);
        } else {
          // No sub-path — add entries directly under the top group
          UKMMImportUI.appendEntryButtons(topEl, entries);
        }
      }

      tree.appendChild(topEl);
    }

    panel.classList.add("visible");
  }

  /**
   * Maps an entry key and its section name to the most appropriate BubbleType.
   * Suffix-based overrides are checked first, then section-based rules.
   * @param {string} entryKey The entry identifier (e.g. "Armor_235_Head_Desc").
   * @param {string} sectionName The section name (e.g. "ActorType/ArmorHead").
   * @returns {string} A BubbleType key (e.g. "dialogue", "item", "compendium", etc.).
   */
  static suggestBubbleType(entryKey, sectionName) {
    // Suffix overrides (checked first — _BaseName before _Name since it's a subset)
    if (entryKey.endsWith("_PictureBook")) return "compendium";
    if (entryKey.endsWith("_BaseName"))    return "signboard";
    if (entryKey.endsWith("_Name"))        return "signboard";

    // Section-based rules
    if (sectionName.startsWith("Tips/"))         return "tip";
    if (sectionName.startsWith("QuestMsg/"))     return "questBOTW";
    if (sectionName.startsWith("ActorType/"))    return "item";
    if (sectionName.startsWith("DemoMsg/"))      return "signboard";
    if (sectionName.startsWith("LayoutMsg/"))    return "signboard";
    if (sectionName.startsWith("StaticMsg/"))    return "signboard";
    if (sectionName.startsWith("EventFlowMsg/")) return "dialogue";
    if (sectionName.startsWith("ShoutMsg/"))     return "dialogue";

    return "dialogue";
  }

  /**
   * Appends entry buttons for each entry in the given map to a container element.
   * @param {Element} container The parent element to append to.
   * @param {Object} entries A map of entryKey → entry objects.
   */
  static appendEntryButtons(container, entries) {
    for (const [entryKey, entry] of Object.entries(entries)) {
      const entryEl = document.createElement("button");
      entryEl.classList.add("ukmm-entry");
      const count = entry.contents ? entry.contents.length : 0;
      entryEl.innerHTML = `<span class="ukmm-entry-name">${entryKey}</span><span class="ukmm-entry-count">${count}</span>`;
      entryEl.addEventListener("click", () => {
        UKMMImportUI.loadEntry(entryKey, entry);
      });
      container.appendChild(entryEl);
    }
  }

  /**
   * Loads a single entry into the bubble editor.
   * @param {string} entryKey The entry key (display only).
   * @param {Object} entry The entry object with `contents` array.
   */
  static loadEntry(entryKey, entry) {
    const contents = entry.contents;
    if (!contents || contents.length === 0) {
      UKMMImportUI.showError(`Entry "${entryKey}" has no contents.`);
      return;
    }

    // Find which section this entry belongs to
    const sectionFromKey = Object.keys(UKMMImportUI.data?.entries || {}).find(
      (s) => UKMMImportUI.data.entries[s][entryKey]
    );

    // Switch bubble type to match the entry
    const suggestedType = UKMMImportUI.suggestBubbleType(entryKey, sectionFromKey || "");
    const typeSelect = document.getElementById("bubble-type");
    if (typeSelect.value !== suggestedType) {
      typeSelect.value = suggestedType;
      // Dispatch a change event so BubbleTools picks it up
      typeSelect.dispatchEvent(new Event("change"));
    }

    // Clear all existing bubbles except the first
    while (BubbleManager.bubbles.length > 1) {
      BubbleManager.deleteBubble(BubbleManager.bubbles[BubbleManager.bubbles.length - 1]);
    }

    // Load contents into the bubble chain (may create multiple bubbles)
    UKMMParser.parseEntry(contents, entryKey, UKMMImportUI.langCode);

    // Update the header to show which entry is loaded
    const chainTitle = document.querySelector(".chain-title h2");
    if (chainTitle) {
      chainTitle.textContent = `${sectionFromKey ? sectionFromKey + " / " : ""}${entryKey}`;
    }
  }

  /** Closes the import side panel. */
  static closePanel() {
    const panel = document.getElementById("ukmm-import-panel");
    panel.classList.remove("visible");
  }

  /** Clears cached data and resets the button to its initial state. */
  static reset() {
    UKMMImportUI.data = null;
    UKMMImportUI.filename = null;
    const btn = document.getElementById("ukmm-import-btn");
    btn.textContent = "Import UKMM";
    btn.title = "Import a ukmmsg2json JSON file";
  }

  /**
   * Shows a transient error message.
   * @param {string} message The error text to display.
   */
  static showError(message) {
    const el = document.getElementById("ukmm-import-error");
    el.textContent = message;
    el.classList.add("visible");
    setTimeout(() => el.classList.remove("visible"), 6000);
  }
}
