import Parser from "./Parser.js";

import Bubble from "./Bubble.js";
import BubbleManager from "./BubbleManager.js";
import BubbleUtil from "./BubbleUtil.js";
import TextColor from "./enums/TextColor.js";
import TextSize from "./enums/TextSize.js";
import BubbleType from "./enums/BubbleType.js";
import PresetAnimation from "./enums/PresetAnimation.js";

/**
 * Maps some Botw language codes (extracted from filename) to language-specific
 * determiner entries. Each entry maps a `two_hundred_one.field_2` key to
 * its display label and article options for that language.
 */
const DETERMINER_LANG = {
  /** English — no gendered articles. */
  en: {},
  /** French */
  fr: {
    "1,0,0,0": { label: "Le / Un", options: ["Le", "Un"] },
    "1,4,0,0": { label: "L' / Un", options: ["L'", "Un"] },
    "2,1,1,0": { label: "La / Une", options: ["La", "Une"] },
    "2,4,1,0": { label: "L' / Une", options: ["L'", "Une"] },
    "1,3,3,1": { label: "Des (m.)", options: ["Des"] },
    "2,3,3,1": { label: "Des (f.)", options: ["Des"] },
    "1,5,5,1": { label: "Une paire de (m.)", options: ["Une paire de"] },
    "2,5,5,1": { label: "Une paire de (f.)", options: ["Une paire de"] },
    "1,2,2,0": { label: "Une pièce de (m. sing.)", options: ["Une pièce de"] },
    "2,2,2,0": { label: "Une pièce de (f. sing.)", options: ["Une pièce de"] },
    "1,8,8,1": { label: "Un bouquet d' (m. pl.)", options: ["Un bouquet d'"] },
    "2,8,8,1": { label: "Un bouquet d' (f. pl.)", options: ["Un bouquet d'"] },
    "1,9,9,1": { label: "Un lot de (m. pl.)", options: ["Un lot de"] },
    "2,9,9,1": { label: "Un lot de (f. pl.)", options: ["Un lot de"] },
    "1,6,6,0": { label: "Un plat de (m. sing.)", options: ["Un plat de"] },
    "1,6,6,1": { label: "Un plat de (m. pl.)", options: ["Un plat de"] },
    "2,6,6,0": { label: "Un plat de (f. sing.)", options: ["Un plat de"] },
    "2,6,6,1": { label: "Un plat de (f. pl.)", options: ["Un plat de"] }
  },
  /** Spanish */
  es: {
    "1,0,0,0": { label: "El / Un", options: ["El", "Un"] },
    "2,1,1,0": { label: "La / Una", options: ["La", "Una"] },
    "2,0,0,0": { label: "El / Una", options: ["El", "Una"] },
    "2,5,5,1": { label: "Las / Unas", options: ["Las", "Unas"] }
  },
  /** Italian */
  it: {
    "1,0,0,0": { label: "Il / Un", options: ["Il", "Un"] },
    "1,1,1,0": { label: "Lo / Un", options: ["Lo", "Un"] },
    "1,3,0,0": { label: "L' / Un", options: ["L'", "Un"] },
    "2,2,2,0": { label: "La / Una", options: ["La", "Una"] },
    "2,3,3,0": { label: "L' / Un'", options: ["L'", "Un'"] },
    "1,5,5,1": { label: "I / Dei", options: ["I", "Dei"] },
    "2,5,5,1": { label: "Le / Delle", options: ["Le", "Delle"] }
  }
};

/**
 * Flat fallback: one entry per field_2 key, taking the first language's label.
 * Used for lookup of selectedVariant.
 */
const DETERMINER_ENTRIES = {};
for (const lang in DETERMINER_LANG) {
  for (const key in DETERMINER_LANG[lang]) {
    if (!DETERMINER_ENTRIES[key]) {
      DETERMINER_ENTRIES[key] = DETERMINER_LANG[lang][key];
    }
  }
}

/** Extends {@link Parser} to export as UKMM-compatible JSON. */
export default class UKMMParser extends Parser {
  /**
   * Parses a ukmmsg2json `contents` array into one or more bubbles in the chain.
   * Handles text with `\n` line breaks, set_colour/reset_colour, text_size,
   * pause nodes, bubble-level animation/sound, and `raw` separator controls
   * which split content into separate bubbles.
   * @param {Array} contents The `contents` array from a ukmmsg2json entry.
   * @param {string} [entryKey] The entry key (e.g. "Armor_235_Head_Name").
   *   When provided and ending with `_Name`, determiner selectors are shown.
   * @param {string} [lang] Optional language code (e.g. "fr", "es", "it")
   *   extracted from the filename. Filters the determiner dropdown to the
   *   variants relevant to that language. Falls back to no variants (empty).
   */
  static parseEntry(contents, entryKey, lang) {
    // Remove any determiner UI left over from a previous import
    document.querySelectorAll(".determiner-ui").forEach((el) => el.remove());

    // Determine the line limit for the current bubble type
    const lineLimit = BubbleManager.type.lineCount || 3;

    // Use the first existing bubble or create one if the chain is empty
    let currentBubble = BubbleManager.bubbles[0];
    if (!currentBubble) {
      BubbleManager.bubbles.push(new Bubble(0));
      currentBubble = BubbleManager.bubbles[0];
    }

    const startBubble = (parentBubble) => {
      const bubble = parentBubble || currentBubble;
      bubble.initializeContents();
      bubble.animation = "none";
      bubble.sound = "none";
      bubble.element.querySelectorAll(".bubble-property-badge").forEach((el) => el.remove());
      return bubble;
    };

    const nextBubble = () => {
      flushText();
      currentBubble.inputHandler();
      // Check existing bubbles first
      const idx = currentBubble.getIndex();
      if (idx + 1 < BubbleManager.bubbles.length) {
        currentBubble = BubbleManager.bubbles[idx + 1];
      } else {
        BubbleManager.addBubble(currentBubble);
        currentBubble = BubbleManager.bubbles[idx + 1];
      }
      startBubble(currentBubble);
      lineCount = 1;
    };

    currentBubble = startBubble(currentBubble);

    let currentLine = currentBubble.bubbleContentElement.firstElementChild;
    let currentColor = TextColor.DEFAULT;
    let currentSize = TextSize.DEFAULT;
    let textBuffer = "";
    let lineCount = 1; // each bubble starts with 1 line

    const startNewLine = () => {
      const newDiv = document.createElement("div");
      currentBubble.bubbleContentElement.appendChild(newDiv);
      currentLine = newDiv;
    };

    /** Flushes the text buffer into a DOM node on the current line. */
    const flushText = () => {
      if (!textBuffer) return;
      if (currentColor === TextColor.DEFAULT && currentSize === TextSize.DEFAULT) {
        currentLine.appendChild(document.createTextNode(textBuffer));
      } else {
        const span = document.createElement("span");
        span.textContent = textBuffer;
        if (currentColor !== TextColor.DEFAULT) {
          span.setAttribute("data-color", currentColor);
        }
        if (currentSize !== TextSize.DEFAULT) {
          span.setAttribute("data-size", currentSize);
        }
        currentLine.appendChild(span);
      }
      textBuffer = "";
    };

    for (const item of contents) {
      if (item.text !== undefined) {
        const parts = item.text.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) {
            flushText();
            lineCount++;
            if (lineCount > lineLimit) {
              // Exceeded the bubble's line count → start a new bubble
              nextBubble();
              currentLine = currentBubble.bubbleContentElement.firstElementChild;
              currentColor = TextColor.DEFAULT;
              currentSize = TextSize.DEFAULT;
            } else {
              startNewLine();
            }
          }
          textBuffer += parts[i];
        }
      } else if (item.control) {
        const ctrl = item.control;
        switch (ctrl.kind) {
          case "set_colour":
            flushText();
            currentColor = ctrl.colour;
            break;
          case "reset_colour":
            flushText();
            currentColor = TextColor.DEFAULT;
            break;
          case "text_size":
            flushText();
            currentSize = String(ctrl.percent);
            break;
          case "pause": {
            flushText();
            const pauseValue = ctrl.frames ?? ctrl.length ?? "short";
            currentLine.appendChild(
              BubbleUtil.newNonTextNode({ pause: pauseValue }, Bubble.pauseNodeCallback)
            );
            break;
          }
          case "animation":
            if (textBuffer) {
              // Animation between text segments acts as a bubble separator
              flushText();
              nextBubble();
              currentLine = currentBubble.bubbleContentElement.firstElementChild;
              currentColor = TextColor.DEFAULT;
              currentSize = TextSize.DEFAULT;
            }
            currentBubble.animation = ctrl.name;
            break;
          case "sound":
            if (textBuffer && ctrl.unknown) {
              // Sound between text segments acts as a bubble separator
              flushText();
              nextBubble();
              currentLine = currentBubble.bubbleContentElement.firstElementChild;
              currentColor = TextColor.DEFAULT;
              currentSize = TextSize.DEFAULT;
            }
            if (ctrl.unknown) {
              currentBubble.sound = ctrl.unknown.join(" ");
            }
            break;
          case "raw":
            if (ctrl.two_hundred_one) {
              // two_hundred_one encodes an article/determiner variant.
              // Only show the selector for *_Name entries.
              flushText();
              const isName = entryKey?.endsWith("_Name");
              if (isName) {
                const fieldKey = ctrl.two_hundred_one.dynamic?.[1]?.field_2?.join(",") || "";
                // Build a variant selector (one of 5 types + none) placed to the left of the bubble
                const oldUI = currentBubble.element.querySelector(".determiner-ui");
                if (oldUI) oldUI.remove();
                const langEntries = (lang && DETERMINER_LANG[lang]) || {};
                const variantKeys = ["", ...Object.keys(langEntries)];
                const selectedVariant = DETERMINER_ENTRIES[fieldKey] ? fieldKey : "";
                currentBubble.determiner = {
                  data: ctrl,
                  variant: selectedVariant
                };
                const ui = document.createElement("span");
                ui.className = "determiner-ui";
                const select = document.createElement("select");
                select.className = "determiner-select";
                // First option: none
                const noneOpt = document.createElement("option");
                noneOpt.value = "";
                noneOpt.textContent = "—";
                if (!selectedVariant) noneOpt.selected = true;
                select.appendChild(noneOpt);
                // One option per variant (label from language-specific entries)
                for (const key of variantKeys.slice(1)) {
                  const opt = document.createElement("option");
                  opt.value = key;
                  opt.textContent = langEntries[key].label;
                  if (key === selectedVariant) opt.selected = true;
                  select.appendChild(opt);
                }
                select.addEventListener("change", () => {
                  const v = select.value;
                  currentBubble.determiner.variant = v;
                });
                ui.appendChild(select);
                currentBubble.element.insertAdjacentElement("afterbegin", ui);
              }
            } else {
              // Other raw controls act as bubble separators
              nextBubble();
              currentLine = currentBubble.bubbleContentElement.firstElementChild;
              currentColor = TextColor.DEFAULT;
              currentSize = TextSize.DEFAULT;
            }
            break;
          // auto_advance — skip silently (inline within bubble)
        }
      }
    }
    flushText();

    // Remove any stale property badges left from a previous import
    document.querySelectorAll(".bubble-property-badge").forEach((el) => el.remove());

    // Add visual badges for animation/sound properties
    for (const bubble of BubbleManager.bubbles) {
      if (bubble.animation !== "none" || bubble.sound !== "none") {
        const badge = document.createElement("span");
        badge.className = "bubble-property-badge";
        const parts = [];
        if (bubble.animation !== "none") parts.push(`Anim: ${bubble.animation}`);
        if (bubble.sound !== "none") parts.push(`Snd: ${bubble.sound}`);
        badge.textContent = parts.join(" | ");
        bubble.element.appendChild(badge);
      }
    }

    // Recalculate overflow on all populated bubbles
    for (const bubble of BubbleManager.bubbles) {
      if (bubble.bubbleContentElement.textContent) {
        bubble.inputHandler();
      }
    }
  }

  /**
   * Exports a set of Bubbles into UKMM JSON.
   * @param {Bubble[]} bubbles An array of Bubble objects.
   * @param {boolean} verbose Whether or not the browser should warn the user about issues.
   * @returns A string containing the exported UKMM JSON.
   */
  export(bubbles, verbose) {
    this.jsonContents = [];
    // Track where each bubble's content starts in jsonContents.
    // Index n = jsonContents length just before bubble n's first entry.
    this._bubbleContentStart = [];
    this._nextBubbleIdx = 0;
    const result = super.export(bubbles, verbose);
    // Insert determiner controls at the start of each bubble's content segment
    for (let b = bubbles.length - 1; b >= 0; b--) {
      const det = bubbles[b].determiner;
      if (det && det.variant) {
        // Build the raw control with the currently selected field_2 bytes
        const fieldBytes = det.variant.split(",").map(Number);
        const rawCtrl = {
          kind: "raw",
          two_hundred_one: {
            dynamic: [0, { len: 4, field_2: fieldBytes }]
          }
        };
        this.jsonContents.splice(this._bubbleContentStart[b], 0, {
          control: rawCtrl
        });
      }
    }
    delete this._bubbleContentStart;
    delete this._nextBubbleIdx;
    return result;
  }

  /**
   * Resets the text buffer and records the start of a new bubble's content
   * in jsonContents (used for determiner insertion).
   */
  startTextNode() {
    this._recordBubbleStart();
    this.plaintextExport = "";
  }

  /**
   * Appends an actual newline to the text buffer
   * (JSON.stringify will escape it as \n in the output).
   */
  addLineBreak() {
    this.plaintextExport += "\n";
  }

  /**
   * Flushes the accumulated text buffer as a {"text": "..."} entry.
   * @param {boolean} isFinal Whether this follows the final node in the export.
   */
  endTextNode(_isFinal) {
    const text = this.plaintextExport;
    if (text) {
      this.jsonContents.push({text});
    }
    this.plaintextExport = "";
  }

  /**
   * Records the start of a new bubble's content segment in jsonContents.
   * Called by entry-point methods for each bubble.
   */
  _recordBubbleStart() {
    if (this._nextBubbleIdx !== undefined && this._bubbleContentStart.length <= this._nextBubbleIdx) {
      this._bubbleContentStart.push(this.jsonContents.length);
      this._nextBubbleIdx++;
    }
  }

  /**
   * Preset animations map to sound values in the UKMM format.
   * @param {Bubble} bubble The {@link Bubble} to get animation/sound information from.
   */
  addPresetAnimNode(bubble) {
    this._recordBubbleStart();
    const animationValue = PresetAnimation.OPTIONS.indexOf(bubble.animation);
    const soundValue = bubble.sound == "animation" ? animationValue + 6 : animationValue;
    this.jsonContents.push({
      control: {
        kind: "sound",
        unknown: [soundValue, 0]
      }
    });
  }

  /**
   * Inserts a control node that sets a custom (non-preset) animation for the bubble.
   * @param {string} animation The name of the animation for the bubble.
   */
  addAnimationNode(animation) {
    this._recordBubbleStart();
    this.jsonContents.push({
      control: {kind: "animation", name: animation}
    });
  }

  /**
   * Inserts a control node that sets a custom (non-preset) sound for the bubble.
   * @param {string} sound The sound data from the bubble ("value1 value2").
   */
  addSoundNode(sound) {
    this._recordBubbleStart();
    const soundArray = sound.split(" ");
    this.jsonContents.push({
      control: {
        kind: "sound",
        unknown: [parseInt(soundArray[0]), parseInt(soundArray[1])]
      }
    });
  }

  /**
   * Inserts a pause node with the given duration.
   * @param {string|number} duration Either a named PauseDuration or a number of frames.
   */
  addPauseNode(duration) {
    if (isNaN(duration)) {
      this.jsonContents.push({
        control: {kind: "pause", length: duration}
      });
    } else {
      this.jsonContents.push({
        control: {kind: "pause", frames: parseInt(duration)}
      });
    }
  }

  /**
   * Inserts a set_colour control node.
   * @param {string} colour A string of type {@link TextColor}.
   */
  addColorNode(colour) {
    this.jsonContents.push({
      control: {kind: "set_colour", colour}
    });
  }

  /**
   * Inserts a reset_colour control node.
   */
  addResetColorNode() {
    this.jsonContents.push({
      control: {kind: "reset_colour"}
    });
  }

  /**
   * Inserts a text_size control node.
   * @param {number} size A number of type {@link TextSize}.
   */
  addSizeNode(size) {
    this.jsonContents.push({
      control: {kind: "text_size", percent: parseInt(size)}
    });
  }

  /**
   * Serializes the accumulated JSON contents array to a pretty-printed JSON string.
   * @param {string} output Ignored (text buffer from base class).
   * @returns {string} Pretty-printed JSON string of the contents array.
   */
  postProcess(output) {
    return JSON.stringify(this.jsonContents, null, 2);
  }
}
