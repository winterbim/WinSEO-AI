"""Tests for geo_stats.py — ported from NEXUS test_core.py test_geo_stats."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GEO_STATS = Path(__file__).resolve().parent / "geo_stats.py"


class GeoStatsTests(unittest.TestCase):
    def _run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(GEO_STATS), *args],
            capture_output=True,
            text=True,
        )

    def test_basic_stats(self):
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", delete=False, suffix=".csv", newline=""
        ) as f:
            f.write("engine,prompt_id,brand_mentioned,client_cited,citation_domains\n")
            f.write("engine-a,p1,true,false,example.org;source.test\n")
            f.write("engine-a,p1,false,true,example.org\n")
            csv_path = f.name

        try:
            r = self._run(csv_path)
            self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
            data = json.loads(r.stdout)
            self.assertEqual(data["input_rows"], 2)
            self.assertIn("engine-a", data["engines"])
            engine = data["engines"]["engine-a"]
            self.assertEqual(engine["runs"], 2)
            self.assertEqual(engine["mention_rate"], 0.5)
            self.assertEqual(engine["client_citation_rate"], 0.5)
            self.assertIsNotNone(engine["mention_wilson95_lower"])
            self.assertIsNotNone(engine["mention_wilson95_upper"])
        finally:
            os.unlink(csv_path)

    def test_wilson_zero_runs(self):
        """Empty CSV should not crash."""
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", delete=False, suffix=".csv", newline=""
        ) as f:
            f.write("engine,prompt_id,brand_mentioned,client_cited\n")
            csv_path = f.name

        try:
            r = self._run(csv_path)
            self.assertNotEqual(r.returncode, 0)
        finally:
            os.unlink(csv_path)

    def test_missing_columns(self):
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", delete=False, suffix=".csv", newline=""
        ) as f:
            f.write("engine,some_column\n")
            f.write("e1,val\n")
            csv_path = f.name

        try:
            r = self._run(csv_path)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("Missing", r.stdout)
        finally:
            os.unlink(csv_path)

    def test_file_not_found(self):
        r = self._run("/nonexistent/path.csv")
        self.assertNotEqual(r.returncode, 0)

    def test_per_prompt_breakdown(self):
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", delete=False, suffix=".csv", newline=""
        ) as f:
            f.write("engine,prompt_id,brand_mentioned,client_cited\n")
            f.write("engine-a,category,true,true\n")
            f.write("engine-a,category,true,false\n")
            f.write("engine-a,comparison,false,true\n")
            csv_path = f.name

        try:
            r = self._run(csv_path)
            self.assertEqual(r.returncode, 0)
            data = json.loads(r.stdout)
            self.assertIn("prompts", data)
            self.assertEqual(len(data["prompts"]), 2)
        finally:
            os.unlink(csv_path)


if __name__ == "__main__":
    unittest.main()