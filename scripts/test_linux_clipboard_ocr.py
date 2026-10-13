import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image


spec = importlib.util.spec_from_file_location(
    "linux_clipboard_ocr", Path(__file__).parent / "linux-clipboard-e2e/ocr_find.py"
)
ocr = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ocr
spec.loader.exec_module(ocr)


class ClipboardOcrTests(unittest.TestCase):
    def run_ocr(self, confidence, scale=3, bounds=()):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "fixture.png"
            Image.new("RGB", (100, 80)).save(image)
            output = io.StringIO()

            def recognize(command, **kwargs):
                with Image.open(command[1]) as scaled:
                    self.assertEqual(scaled.size, (100 * scale, 80 * scale))
                return subprocess.CompletedProcess(command, 0,
                    "text\tconf\tleft\ttop\twidth\theight\n"
                    f"Aider\t{confidence}\t{20 * scale}\t{30 * scale}"
                    f"\t{40 * scale}\t{10 * scale}\n")

            with patch.object(sys, "argv", ["ocr_find.py", str(image), "Aider",
                                            "--scale", str(scale), *bounds]), \
                    patch.object(ocr.subprocess, "run", side_effect=recognize), \
                    patch.object(sys, "stdout", output):
                result = ocr.main()
            return result, output.getvalue()

    def test_scaled_recognition_returns_original_window_coordinates(self):
        self.assertEqual(self.run_ocr(93), (0, "40 35 20 30 40 10 Aider\n"))
        self.assertEqual(self.run_ocr(93, scale=1), (0, "40 35 20 30 40 10 Aider\n"))

    def test_scaling_does_not_lower_the_confidence_gate(self):
        self.assertEqual(self.run_ocr(0.48), (1, ""))

    def test_bounds_still_use_original_window_coordinates(self):
        self.assertEqual(self.run_ocr(93, bounds=("--min-x", "41")), (1, ""))


if __name__ == "__main__":
    unittest.main()
