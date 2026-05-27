Vendorisation du décodeur Zstd (zstddec)

Placez ici les fichiers suivants si vous souhaitez une décompression Zstd locale (offline) :

- `zstddec.modern.js` — module JS exposant `ZSTDDecoder`.
- `zstddec.wasm` — le binaire WASM utilisé par le module.

Le loader JavaScript de l'application tentera d'importer d'abord `./vendor/zstddec.modern.js` puis reviendra au CDN si absent.

Pour obtenir ces fichiers :

1. Récupérez-les depuis la distribution du projet `zstddec` (par ex. via npm/unpkg).
2. Copiez `dist/zstddec.modern.js` et son `*.wasm` associé ici.

Notes:
- Si votre fichier Zstd requiert un dictionnaire, placez le fichier dictionnaire sous `scripts/zstd_dict.bin` ou utilisez l'option `--zstd-dict` du script Python `scripts/extract_sarc.py`.
