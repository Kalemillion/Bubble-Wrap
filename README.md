# Bubble Wrap

A visual text bubble editor for _The Legend of Zelda: Breath of the Wild_ and _The Legend of Zelda: Tears of the Kingdom_.

## Features

### Automatic text wrapping

The editor works just like a regular text box -- eliminating guesswork and providing instant visual feedback. The spacing and wrapping behaviors have been tested for accuracy against a variety of vanilla text. The currently supported formats are:

- NPC dialogue
- Sign dialogs
- Item descriptions (also accounts for the in-game character limit)
- Hyrule Compendium entries
- Quest logs
- Loading screen tips

### Hassle-free control nodes

Say goodbye to extra and missing spaces in your text. Coloring, resizing, and adding pauses is as easy as selecting a portion of text and applying the desired effect. In addition, presets are available for the most common animation/sound control nodes, but with full support for custom values. When it comes time to export, the control nodes are intelligently inserted so minimal manual tweakage is required.

### Smart paste

Simply paste a set of dialogue from your planning document into a bubble -- the text will automatically be wrapped and broken into multiple bubbles based on line breaks. Plus, sneaky variants of apostrophes and other characters are weeded out and replaced with the correct in-game versions.

### Effortless syntax export

Easily export your bubbles for use in MSYT files, NX Editor, or MSBT Editor. Select your game and format of choice, then hit the button or keyboard shortcut to copy the syntax to the clipboard. Never type a `\n` again.

### Local folder explorer

Open a local folder in the sidebar to browse its contents in a VS Code-style tree. The browser will keep the folder local to your session; nothing is uploaded.

### Extraction helper

Use `scripts/extract_sarc.py` to unpack a UKMM SARC into a real folder tree. Open the resulting folder in Bubble Wrap to browse the extracted entries in the sidebar tree. The script keeps nested paths intact and automatically unwraps Yaz0 members. If the archive is Zstd-compressed, install the Python dependency first:

```bash
python -m pip install zstandard
python scripts/extract_sarc.py Msg_EUfr.product.sarc outdir
```

Bubble Wrap can also open a `.zip` directly and show its internal tree, so a mod archive such as `AppData\Local\ukmm\wiiu\mods\{mod_name}.zip` can be browsed without extracting it first.

## Install

Bubble Wrap is a web app: no installation is required, and it works on all platforms. However, if your browser supports it, you may install it offline.

Access Bubble Wrap at https://lisa-wolfgang.github.io/Bubble-Wrap.

## Contributing

Pull requests are welcome! Please read the [contributing guidelines](CONTRIBUTING.md) for more information.
