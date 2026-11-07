"""CommonMark 反斜杠转义的回归测试（python -m unittest discover -s tests）。"""
import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import mdparse  # noqa: E402


class EscapeRenderTest(unittest.TestCase):
    def render(self, md: str, title: str = "测试文章标题") -> str:
        blocks = mdparse.parse_markdown(md)
        blocks = mdparse.clean_blocks(blocks, title)
        blocks = mdparse.attach_captions(blocks)
        html, _ = mdparse.render_article("x", title, "课程", "2026-11-07", blocks, {})
        return html

    def test_underscore(self):
        self.assertIn("tb_s1", self.render(r"tb\_s1"))

    def test_star(self):
        html = self.render(r"KV\*2，以及 \*不是强调\*")
        self.assertIn("KV*2", html)
        self.assertIn("*不是强调*", html)
        self.assertNotIn("<em>", html)

    def test_dollar(self):
        self.assertIn("$/successful task", self.render(r"成本 \$/successful task"))

    def test_code_block_kept(self):
        html = self.render("```\na\\_b\n```")
        self.assertIn("a\\_b", html)

    def test_inline_code_kept(self):
        html = self.render("`a\\_b`")
        self.assertIn("<code>a\\_b</code>", html)

    def test_mermaid_source_kept(self):
        html = self.render("```mermaid\nflowchart LR\n A[a\\_b] --> B\n```")
        self.assertIn("a\\_b", html)

    def test_escaped_markup_not_parsed(self):
        html = self.render(r"\<b>不是粗体\</b>")
        self.assertNotIn("<strong>", html)
        self.assertIn("&lt;b&gt;不是粗体&lt;/b&gt;", html)

    def test_plain_text_unescape(self):
        self.assertEqual(mdparse._strip_inline(r"tb\_s1 和 KV\*2"), "tb_s1 和 KV*2")


if __name__ == "__main__":
    unittest.main()


class BrokenFenceRepairTest(unittest.TestCase):
    def test_escaped_mermaid_fence(self):
        md = ("\\`\\`\\`mermaid<br />flowchart LR<br />A\\[过去数据与当前证据\\] --> B\\[定义事件\\]<br />"
              "B --> C\\[估计概率\\]<br />\\`\\`\\`")
        blocks = mdparse.parse_markdown(md)
        self.assertEqual([b.type for b in blocks], ["code"])
        self.assertEqual(blocks[0].lang, "mermaid")
        self.assertIn("A[过去数据与当前证据]", blocks[0].code)
        self.assertNotIn("\\", blocks[0].code)

    def test_repair_no_residual(self):
        md = ("intro\\_text\n\n"
              "\\`\\`\\`mermaid<br />flowchart LR<br />A[x\\_y] --> B<br />\\`\\`\\`")
        blocks = mdparse.attach_captions(mdparse.parse_markdown(md))
        html, _ = mdparse.render_article("x", "测试文章标题", "课程", "2026-11-07", blocks, {})
        self.assertNotIn("\\_", html)
        self.assertNotIn("\\`", html)


class DisplayMathTest(unittest.TestCase):
    def test_display_math_preserved(self):
        md = "说明\n\n$$ x= \\\\begin{bmatrix} \\\\text{动量} \\\\\\\\ \\\\text{价值} \\\\end{bmatrix} $$\n"
        blocks = mdparse.parse_markdown(md)
        self.assertIn("code", [b.type for b in blocks])
        code = [b for b in blocks if b.type == "code"][0]
        self.assertEqual(code.lang, "math")
        self.assertIn("\\\\begin{bmatrix}", code.code)
        html, _ = mdparse.render_article("x", "测试文章标题", "课程", "2026-11-07", blocks, {})
        self.assertIn("math", html)
        self.assertNotIn("\\begin", re.sub(r"<pre.*?</pre>", "", html, flags=re.S))
