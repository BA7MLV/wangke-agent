import concurrent.futures
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parent.parent / "infra/sandbox/save-file.py"
spec = importlib.util.spec_from_file_location("save_file", SCRIPT)
save = importlib.util.module_from_spec(spec)
spec.loader.exec_module(save)


class SaveFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="save-file-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.source = self.root / "source.txt"
        self.source.write_text("first output", encoding="utf-8")

    def publish(self, name, **options):
        return save.publish(str(self.source), name, str(self.workspace), **options)

    def test_readable_names_collision_and_idempotency(self):
        first = self.publish("分析报告/计算结果.txt")
        self.assertFalse(first["reused"])
        self.assertTrue(self.publish("分析报告/计算结果.txt")["reused"])
        self.source.write_text("second output", encoding="utf-8")
        second = self.publish("分析报告/计算结果.txt")
        self.assertEqual(second["path"], "分析报告/计算结果 (2).txt")
        self.assertTrue(self.publish("分析报告/计算结果.txt")["reused"])
        self.assertEqual((self.workspace / first["path"]).read_text(), "first output")
        self.assertEqual(len(list((self.workspace / "分析报告").iterdir())), 2)
        with self.assertRaises(FileExistsError):
            self.publish("分析报告/计算结果.txt", on_conflict="error")
        (self.workspace / first["path"]).unlink()
        retry = self.publish("分析报告/计算结果.txt")
        self.assertEqual(retry["path"], second["path"])
        self.assertTrue(retry["reused"])
        self.assertFalse((self.workspace / first["path"]).exists())

    def test_raster_extensions_and_unicode_byte_limit(self):
        # This helper checks signatures. The API separately validates image headers.
        self.source.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + bytes(16))
        saved = self.publish("函数曲线.jpg")
        self.assertEqual(saved["path"], "函数曲线.png")
        self.assertEqual(save.safe_name("原图.JPEG", "jpeg"), "原图.JPEG")
        saved = self.publish("😀中文" * 80 + ".jpg")
        self.assertLessEqual(len(saved["path"].encode("utf-8")), 240)
        self.assertTrue(saved["path"].endswith(".png"))
        self.source.write_text("not an image")
        with self.assertRaisesRegex(ValueError, "invalid_image_format"):
            self.publish("fake.png")

    def test_concurrent_writers_no_overwrite_or_duplicate_identical_outputs(self):
        # Separate processes exercise the real atomic installation rather than a thread lock.
        code = "import importlib.util,json,sys;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('save',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.publish(sys.argv[2],'结果.txt',sys.argv[3])))"
        def invoke(_):
            return json.loads(subprocess.check_output(["python3", "-c", code, str(SCRIPT), str(self.source), str(self.workspace)], text=True))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(invoke, range(16)))
        self.assertTrue(all(r["path"] == "结果.txt" for r in results))
        self.assertEqual([p.name for p in self.workspace.iterdir()], ["结果.txt"])
        self.assertEqual(sum(not r["reused"] for r in results), 1)

    def test_path_link_and_failure_guards(self):
        for name in ("../outside.txt", "/etc/test.txt", "a/../b.txt", "a\\b.txt"):
            with self.assertRaises(ValueError):
                self.publish(name)
        (self.workspace / "link").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.publish("link/outside.txt")
        (self.workspace / "result.txt").symlink_to(self.source)
        self.assertEqual(self.publish("result.txt")["path"], "result (2).txt")
        self.assertEqual(self.source.read_text(), "first output")
        self.assertEqual(list(self.workspace.glob(".save-*")), [])
        self.source.write_bytes(b"")
        with self.assertRaises(ValueError):
            self.publish("empty.txt")
        self.assertEqual(list(self.workspace.glob(".save-*")), [])

    def test_concurrent_different_content_never_clobbers(self):
        sources = []
        for i in range(16):
            source = self.root / f"source-{i}.txt"
            source.write_text(f"artifact {i}")
            sources.append(source)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda p: save.publish(str(p), "result.txt", str(self.workspace)), sources))
        self.assertEqual(len({r["path"] for r in results}), 16)
        self.assertEqual({p.read_text() for p in self.workspace.iterdir()}, {f"artifact {i}" for i in range(16)})


if __name__ == "__main__":
    unittest.main()
