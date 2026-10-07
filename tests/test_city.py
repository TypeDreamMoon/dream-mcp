"""DreamCity through the same tools: a city is its .dct or its package, it always takes the
driver, and what comes back is read from the driver's JSON report rather than its log.

The report's shape is the commandlet's (`DreamCityCompileCommandlet.cpp`, WriteReport); the
live test runs the real driver on the library's island when DREAM_MCP_CITY_HOST names a host
project (.uproject) with DreamCity in it.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from dream_mcp import server
from dream_mcp.city import driver as city
from dream_mcp.core.locate import Project

REPORT = {
    "city": "@dreamcity/cities/Island",
    "file": "I:/Host/Plugins/DreamCity/Library/cities/Island.dct",
    "compiled": True,
    "errors": 1,
    "warnings": 2,
    "blocks": 68,
    "lots": 332,
    "pieces": 131092,
    "diagnostics": [
        {"code": "DCT5201", "severity": "warning", "message": "junctions overlap", "file": "", "line": 0,
         "column": 0, "count": 1, "ids": ["DC:edge:70b6b3255179a69b"]},
        {"code": "DCG5020", "severity": "warning", "message": "split leaves a gap",
         "file": "I:/Host/Plugins/DreamCity/Library/grammars/NY_Tower.dcg", "line": 12, "column": 13,
         "count": 40, "ids": []},
        {"code": "DCT2003", "severity": "error", "message": "no road class Nowhere",
         "file": "I:/Host/Plugins/DreamCity/Library/cities/Island.dct", "line": 4, "column": 54,
         "count": 1, "ids": []},
    ],
}


def test_a_report_reads_into_diagnostics_with_their_counts(tmp_path: Path) -> None:
    path = tmp_path / "Island.json"
    path.write_text(json.dumps(REPORT), encoding="utf-8")
    report = city.read_report(path)
    assert report is not None
    assert (report.compiled, report.blocks, report.lots, report.pieces) == (True, 68, 332, 131092)
    assert [d.code for d in report.diagnostics] == ["DCT5201", "DCG5020", "DCT2003"]
    assert report.counts == [1, 40, 1]
    assert report.diagnostics[2].is_error


def test_a_layout_diagnostic_keeps_no_made_up_position() -> None:
    report_item = city.Diagnostic(file="", line=0, column=0, severity="warning", code="DCT5201",
                                  message="junctions overlap")
    assert city.describe(report_item) == "(the layout): warning DCT5201: junctions overlap"
    located = city.Diagnostic(file="a.dcg", line=12, column=13, severity="warning", code="DCG5020",
                              message="gap")
    assert city.describe(located, 40) == "a.dcg(12,13): warning DCG5020: gap (x40)"


def test_cities_are_told_apart_from_other_sources() -> None:
    assert city.is_city_target("@dreamcity/cities/Island")
    assert city.is_city_target("DCity/cities/Harbour.dct")
    assert city.is_city_target("/Game/cities/Harbour")
    assert not city.is_city_target("DFX/Fire.dfs")
    assert not city.is_city_target("DShader/M_Toon.dsm")


def test_a_grammar_is_verified_through_its_city(tmp_path: Path) -> None:
    project = Project(uproject=tmp_path / "Host.uproject", engine_root=tmp_path)
    reply = server._run_city(True, "Library/grammars/NY_Tower.dcg", project)
    assert "compiled with the city that names it" in reply


def test_no_driver_says_where_it_looked(tmp_path: Path) -> None:
    project = Project(uproject=tmp_path / "Host.uproject", engine_root=tmp_path)
    reply = server._run_city(True, "@dreamcity/cities/Island", project)
    assert "No driver at" in reply


HOST = Path(os.environ.get("DREAM_MCP_CITY_HOST", ""))


@pytest.mark.skipif(not HOST.is_file() or shutil.which("pwsh") is None, reason="DREAM_MCP_CITY_HOST names no DreamCity host")
def test_the_island_verifies_through_the_driver() -> None:
    reply = server.dream_verify("@dreamcity/cities/Island", project_dir=str(HOST))
    if "an editor has the project open" in reply:
        pytest.skip("an editor has the host open")
    assert "route: cli" in reply
    assert "OK (exit 0)" in reply
    assert "0 error(s)" in reply
    assert "blocks" in reply and "lots" in reply
