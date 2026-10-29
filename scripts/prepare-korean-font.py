"""Optional maintainer-only preparation; the browser uses the committed TTF.

Requires fontTools 4.55.0. Input is the pinned Google Fonts variable source:
https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf
"""

import argparse
import hashlib
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", type=Path, help="Original NotoSansKR[wght].ttf")
parser.add_argument("output", type=Path, help="Output static NotoSansKR-Regular.ttf")
args = parser.parse_args()
expected_hash = "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252"
if hashlib.sha256(args.input.read_bytes()).hexdigest() != expected_hash:
    raise SystemExit("Source font hash mismatch; review the font update before preparing it.")
font = TTFont(args.input, recalcTimestamp=False)
font = instantiateVariableFont(font, {"wght": 400}, inplace=True, updateFontNames=True)
font.recalcTimestamp = False
# pdf-lib writes horizontal PDF text. Remove substitutions with alternate glyphs
# whose Unicode or width mappings its fontkit adapter cannot reliably retain.
for table in ("GSUB", "GPOS", "GDEF", "BASE", "vhea", "vmtx", "VORG"):
    if table in font:
        del font[table]
# fontkit's short-loca subset writer needs even source glyph offsets. The
# fontTools default of one-byte padding can produce visually missing glyphs.
font["glyf"].padding = 4
args.output.parent.mkdir(parents=True, exist_ok=True)
font.save(args.output)
print(hashlib.sha256(args.output.read_bytes()).hexdigest(), args.output)
