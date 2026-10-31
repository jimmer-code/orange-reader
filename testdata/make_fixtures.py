#!/usr/bin/env python3
"""Builds the small test fixtures: an ePub without a cover, a fake DRM ePub, and a photo of a Moby-Dick page."""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
OPF = '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">{ident}</dc:identifier><dc:title>{title}</dc:title><dc:creator>Shubian Test</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'''
NAV = '''<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>
<nav epub:type="toc"><ol><li><a href="c1.xhtml">The Harbour</a></li><li><a href="c2.xhtml">The Light</a></li></ol></nav></body></html>'''
PARA = ("The harbour lay quiet under a pale sky, and the old keeper walked the length of the mole each evening, "
        "counting the gulls and the slow return of the fishing boats. ")
def chapter(title, n):
    body = "".join(f"<p>{PARA * 3}</p>" for _ in range(n))
    return f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><h2>{title}</h2>{body}</body></html>'

def epub(name, title, drm=False):
    with zipfile.ZipFile(os.path.join(HERE, name), "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        if drm:
            z.writestr("META-INF/encryption.xml", '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>')
        z.writestr("OEBPS/content.opf", OPF.format(ident=name, title=title))
        z.writestr("OEBPS/nav.xhtml", NAV)
        z.writestr("OEBPS/c1.xhtml", chapter("The Harbour", 12))
        z.writestr("OEBPS/c2.xhtml", chapter("The Light", 8))

def photo():
    from PIL import Image, ImageDraw, ImageFont
    text = ("It is a way I have of driving off the spleen and regulating the circulation. Whenever I find myself growing grim "
            "about the mouth; whenever it is a damp, drizzly November in my soul; whenever I find myself involuntarily pausing "
            "before coffin warehouses, and bringing up the rear of every funeral I meet; and especially whenever my hypos get "
            "such an upper hand of me, that it requires a strong moral principle to prevent me from deliberately stepping into "
            "the street, and methodically knocking people's hats off, then, I account it high time to get to sea as soon as I can. "
            "There now is your insular city of the Manhattoes, belted round by wharves as Indian isles by coral reefs; commerce "
            "surrounds it with her surf. Its extreme downtown is the battery, where that noble mole is washed by waves, and "
            "cooled by breezes, which a few hours previous were out of sight of land.")
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 34)
    W, margin = 1300, 90
    page = Image.new("RGB", (W, 1500), (249, 249, 248))
    d = ImageDraw.Draw(page)
    y, line = margin, ""
    for word in text.split():
        trial = (line + " " + word).strip()
        if d.textlength(trial, font=font) > W - 2 * margin:
            d.text((margin, y), line, font=font, fill=(33, 32, 28)); y += 54; line = word
        else:
            line = trial
    d.text((margin, y), line, font=font, fill=(33, 32, 28))
    page = page.crop((0, 0, W, y + 54 + margin))
    # 轻微透视，模拟手持拍摄
    w, h = page.size
    bg = Image.new("RGB", (w + 160, h + 160), (120, 112, 100))
    bg.paste(page, (80, 80))
    coeffs = find_coeffs([(0, 0), (w + 160, 0), (w + 160, h + 160), (0, h + 160)], [(30, 10), (w + 120, 40), (w + 150, h + 150), (5, h + 130)])
    bg = bg.transform(bg.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    bg.save(os.path.join(HERE, "moby-dick-page.jpg"), quality=88)

def find_coeffs(dst, src):
    import numpy as np
    m = []
    for (x, y), (u, v) in zip(dst, src):
        m.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); m.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    a = np.array(m, dtype=float); b = np.array(src, dtype=float).reshape(8)
    return np.linalg.solve(a, b).tolist()

if __name__ == "__main__":
    epub("no-cover.epub", "The Lighthouse Notes")
    epub("drm-test.epub", "Locked Book", drm=True)
    photo()
    print("ok")
