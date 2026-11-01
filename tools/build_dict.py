#!/usr/bin/env python3
"""Build app/src/main/assets/dict.db from ECDICT.

Inputs (not in Git): tools/cache/ecdict.csv, tools/cache/lemma.en.txt
  https://github.com/skywind3000/ECDICT (MIT)
Also reads tools/supplement.tsv: extra senses for literary or archaic words
that ECDICT lacks (word<TAB>line to append to its translation).
"""
import csv
import gzip
import os
import re
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache")
OUT = os.path.join(ROOT, "..", "app", "src", "main", "assets", "dict.db")
EXTRA_OUT = os.path.join(ROOT, "..", "app", "src", "main", "assets", "dict_extra.tsv.gz")
TOP = 60000
PHRASE_HEADS = 5000
PHRASE_WORDS = 4
EXTRA_WORD_MAX = 8
TAGS = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}
KINDS = {"p", "d", "i", "3", "s", "r", "t"}
WORD_RE = re.compile(r"^[a-z][a-z'\-]*(?: [a-z][a-z'\-]*)*$")


def rank_of(row):
    ranks = [int(x) for x in (row["frq"], row["bnc"]) if x and x.isdigit() and int(x) > 0]
    return min(ranks) if ranks else None


def clean_phonetic(p):
    p = p.replace("ә", "ə")  # ECDICT uses Cyrillic schwa
    return p.strip()


def main():
    rows = {}
    csv.field_size_limit(sys.maxsize)
    with open(os.path.join(CACHE, "ecdict.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            w = row["word"]
            if not w or w.isdigit():
                continue
            if len(w) > 1 and w.isupper():
                continue
            lw = w.lower()
            if not WORD_RE.match(lw):
                continue
            trans = (row["translation"] or "").replace("\\n", "\n").strip()
            if not trans:
                continue
            r = rank_of(row)
            keep_extra = bool(TAGS & set((row["tag"] or "").split())) or (row["collins"] or "0") not in ("", "0") or row["oxford"] == "1"
            prev = rows.get(lw)
            # Prefer the lowercase spelling when ECDICT has both "Mole" and "mole".
            if prev and prev["orig"] == lw and w != lw:
                continue
            rows[lw] = {"orig": w, "phonetic": clean_phonetic(row["phonetic"] or ""), "trans": trans,
                        "rank": r, "extra": keep_extra, "exchange": row["exchange"] or ""}

    ranked = sorted((v["rank"], k) for k, v in rows.items() if v["rank"] and " " not in k)
    common_heads = {k for _, k in ranked[:PHRASE_HEADS]}
    keep = {k for _, k in ranked[:TOP]} | {k for k, v in rows.items() if v["extra"]}

    sup_path = os.path.join(ROOT, "supplement.tsv")
    with open(sup_path, encoding="utf-8") as f:
        for line in f:
            if not line.strip() or line.startswith("#"):
                continue
            w, extra = line.rstrip("\n").split("\t", 1)
            rows[w]["trans"] = rows[w]["trans"] + "\n" + extra
            keep.add(w)

    forms = {}

    def add_form(form, lemma, kind):
        if form != lemma and lemma in keep and WORD_RE.match(form) and form not in forms:
            forms[form] = (lemma, kind)

    for w in keep:
        for part in rows[w]["exchange"].split("/"):
            if ":" not in part:
                continue
            k, v = part.split(":", 1)
            if k in KINDS:
                add_form(v.lower(), w, k)

    with open(os.path.join(CACHE, "lemma.en.txt"), encoding="utf-8") as f:
        for line in f:
            if line.startswith(";") or "->" not in line:
                continue
            head, tail = line.split("->")
            lemma = head.split("/")[0].strip().lower()
            for form in tail.strip().split(","):
                form = form.strip().lower()
                if form.endswith("ing"):
                    kind = "i"
                elif form.endswith("ed"):
                    kind = "p"
                elif form.endswith("s"):
                    kind = "s"
                else:
                    kind = "p"
                add_form(form, lemma, kind)

    # Rare plural entries such as "hypos" exist as their own rankless entries;
    # link them to the base word so the card shows both.
    for w in list(keep):
        if w in forms or rows[w]["rank"]:
            continue
        for suf, kind in (("es", "s"), ("s", "s")):
            if w.endswith(suf) and w[: -len(suf)] in keep and len(w) - len(suf) >= 3:
                add_form(w, w[: -len(suf)], kind)
                break

    for path in (OUT, OUT + ".gz", EXTRA_OUT):
        if os.path.exists(path):
            os.remove(path)
    db = sqlite3.connect(OUT)
    db.executescript("""
        CREATE TABLE entry (word TEXT PRIMARY KEY, phonetic TEXT, trans TEXT NOT NULL, rank INTEGER) WITHOUT ROWID;
        CREATE TABLE form (form TEXT PRIMARY KEY, lemma TEXT NOT NULL, kind TEXT NOT NULL) WITHOUT ROWID;
    """)
    db.executemany("INSERT INTO entry VALUES (?,?,?,?)",
                   sorted((w, rows[w]["phonetic"], rows[w]["trans"], rows[w]["rank"]) for w in keep))
    db.executemany("INSERT INTO form VALUES (?,?,?)", sorted((f, l, k) for f, (l, k) in forms.items()))
    db.commit()
    db.execute("VACUUM")
    check(db)
    n_entry = db.execute("SELECT count(*) FROM entry").fetchone()[0]
    n_form = db.execute("SELECT count(*) FROM form").fetchone()[0]
    db.close()

    extra_keep = {k for k in rows if k not in keep and " " not in k and len(k) <= EXTRA_WORD_MAX}
    extra_keep |= {k for k in rows if " " in k and len(k.split()) <= PHRASE_WORDS and k.split()[0] in common_heads}
    assert "by and large" in extra_keep
    with gzip.open(EXTRA_OUT, "wt", encoding="utf-8", newline="") as out:
        for w in sorted(extra_keep):
            out.write(w + "\t" + rows[w]["trans"].replace("\n", "\\n") + "\n")
    phrase_count = sum(" " in w for w in extra_keep)
    print(f"entries {n_entry}, forms {n_form}, extra entries {len(extra_keep)}, phrases {phrase_count}, extra compressed {os.path.getsize(EXTRA_OUT) / 1e6:.1f} MB")


def check(db):
    def lemma(w):
        r = db.execute("SELECT lemma FROM form WHERE form=?", (w,)).fetchone()
        return r and r[0]

    def trans(w):
        return db.execute("SELECT trans FROM entry WHERE word=?", (w,)).fetchone()[0]

    assert lemma("wharves") == "wharf"
    assert lemma("hypos") == "hypo"
    assert lemma("knocking") == "knock"
    assert "防波堤" in trans("mole")
    assert "忧郁" in trans("spleen") or "郁闷" in trans("spleen")


if __name__ == "__main__":
    main()
